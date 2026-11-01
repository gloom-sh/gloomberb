//! Prototype: the composite chart's pixel work as one WebAssembly module.
//!
//! TypeScript still lays a panel out (projection, axes, column widths,
//! colours) and records each drawing call it makes into a list of f64 ops;
//! this module replays the list into an RGBA buffer in its own memory. The
//! ops mirror src/components/chart/native/raster/primitives.ts and the area
//! fill in src/components/chart/composite/rasterizer.ts operation for
//! operation, with JavaScript's rounding, min/max and hypot, so the pixels
//! match the TypeScript rasterizer byte for byte.
//!
//! Op list (all f64):
//!   1 FILL_OPAQUE r g b
//!   2 FILL_RECT   left top right bottom r g b a opacity
//!   3 LINE        x0 y0 x1 y1 r g b a thickness
//!   4 CIRCLE      cx cy radius r g b a
//!   5 BLEND_PIXEL x y r g b a opacity
//!   6 AREA        n baseline step r g b a, then n x y breakBefore triples

use std::cell::RefCell;

#[derive(Clone, Copy)]
struct Rgba {
    r: f64,
    g: f64,
    b: f64,
    a: f64,
}

// ---------------------------------------------------------------------------
// JavaScript number semantics

#[inline(always)]
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

#[inline(always)]
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.max(min, Math.min(max, value))`, as src/utils/math.ts.
#[inline(always)]
fn clamp(value: f64, min: f64, max: f64) -> f64 {
    js_max(min, js_min(max, value))
}

/// `Math.round`: halves go up, toward +infinity.
#[inline(always)]
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// A store into a Uint8Array of a value the caller rounded: NaN is 0, the rest wraps.
#[inline(always)]
fn to_u8(x: f64) -> u8 {
    if x.is_nan() || x.is_infinite() {
        0
    } else {
        (x as i64).rem_euclid(256) as u8
    }
}

/// `Math.hypot(x, y)` as V8 and JavaScriptCore compute it: scaled by the
/// larger magnitude, with a compensated sum.
#[inline(always)]
fn js_hypot(x: f64, y: f64) -> f64 {
    let ax = x.abs();
    let ay = y.abs();
    if ax.is_infinite() || ay.is_infinite() {
        return f64::INFINITY;
    }
    if ax.is_nan() || ay.is_nan() {
        return f64::NAN;
    }
    let max = if ax > ay { ax } else { ay };
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut compensation = 0.0;
    for value in [ax, ay] {
        let n = value / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// Inclusive loop bounds from JavaScript numbers: none when either is NaN.
#[inline(always)]
fn bounds(from: f64, to: f64) -> Option<(i64, i64)> {
    if from.is_nan() || to.is_nan() {
        None
    } else {
        Some((from as i64, to as i64))
    }
}

fn smoothstep(edge0: f64, edge1: f64, value: f64) -> f64 {
    let range = edge1 - edge0;
    if range == 0.0 {
        return if value < edge0 { 0.0 } else { 1.0 };
    }
    let t = clamp((value - edge0) / range, 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

// ---------------------------------------------------------------------------
// Primitives

#[inline(always)]
fn blend_at(data: &mut [u8], index: usize, color: Rgba, alpha: f64) {
    let dst_alpha = data[index + 3];
    if dst_alpha == 255 {
        let keep = 1.0 - alpha;
        data[index] = to_u8(js_round(color.r * alpha + data[index] as f64 * keep));
        data[index + 1] = to_u8(js_round(color.g * alpha + data[index + 1] as f64 * keep));
        data[index + 2] = to_u8(js_round(color.b * alpha + data[index + 2] as f64 * keep));
        return;
    }
    let dst = dst_alpha as f64 / 255.0;
    let out_alpha = alpha + dst * (1.0 - alpha);
    if out_alpha <= 0.0 {
        return;
    }
    let dst_factor = dst * (1.0 - alpha);
    data[index] = to_u8(js_round((color.r * alpha + data[index] as f64 * dst_factor) / out_alpha));
    data[index + 1] = to_u8(js_round((color.g * alpha + data[index + 1] as f64 * dst_factor) / out_alpha));
    data[index + 2] = to_u8(js_round((color.b * alpha + data[index + 2] as f64 * dst_factor) / out_alpha));
    data[index + 3] = to_u8(js_round(out_alpha * 255.0));
}

fn blend_pixel(data: &mut [u8], width: f64, height: f64, x: f64, y: f64, color: Rgba, opacity: f64) {
    if x < 0.0 || y < 0.0 || x >= width || y >= height {
        return;
    }
    // Only whole pixels exist: a typed array ignores a fractional index.
    if x.fract() != 0.0 || y.fract() != 0.0 {
        return;
    }
    let alpha = clamp((color.a / 255.0) * opacity, 0.0, 1.0);
    if alpha <= 0.0 {
        return;
    }
    let index = ((y * width + x) * 4.0) as usize;
    blend_at(data, index, color, alpha);
}

const LINE_FEATHER: f64 = 1.1;

#[allow(clippy::too_many_arguments)]
fn draw_line(data: &mut [u8], width: f64, height: f64, x0: f64, y0: f64, x1: f64, y1: f64, color: Rgba, thickness: f64) {
    let half = thickness / 2.0;
    let reach = half + LINE_FEATHER;
    let color_alpha = clamp(color.a / 255.0, 0.0, 1.0);
    if color_alpha <= 0.0 {
        return;
    }
    let min_x = js_max(0.0, (js_min(x0, x1) - half - 1.0).floor());
    let max_x = js_min(width - 1.0, (js_max(x0, x1) + half + 1.0).ceil());
    let min_y = js_max(0.0, (js_min(y0, y1) - half - 1.0).floor());
    let max_y = js_min(height - 1.0, (js_max(y0, y1) + half + 1.0).ceil());
    let dx = x1 - x0;
    let dy = y1 - y0;
    let length_sq = dx * dx + dy * dy;
    let segment_length_sq = if length_sq == 0.0 || length_sq.is_nan() { 1.0 } else { length_sq };
    let reach_sq = reach * reach;
    let band_half_width = if dy != 0.0 {
        (reach * segment_length_sq.sqrt()) / dy.abs() + 1.0
    } else {
        f64::INFINITY
    };
    let w = width as usize;
    let Some((row_from, row_to)) = bounds(min_y, max_y) else { return };
    for py in row_from..=row_to {
        let pyf = py as f64;
        let cy = pyf + 0.5;
        let mut row_min = min_x;
        let mut row_max = max_x;
        if dy != 0.0 {
            let center_x = x0 + (dx * (cy - y0)) / dy - 0.5;
            row_min = js_max(min_x, (center_x - band_half_width).floor());
            row_max = js_min(max_x, (center_x + band_half_width).ceil());
        }
        let row_index = py as usize * w;
        let Some((col_from, col_to)) = bounds(row_min, row_max) else { continue };
        for px in col_from..=col_to {
            let cx = px as f64 + 0.5;
            let mut projection = ((cx - x0) * dx + (cy - y0) * dy) / segment_length_sq;
            projection = if projection < 0.0 { 0.0 } else if projection > 1.0 { 1.0 } else { projection };
            let offset_x = cx - (x0 + dx * projection);
            let offset_y = cy - (y0 + dy * projection);
            let distance_sq = offset_x * offset_x + offset_y * offset_y;
            if distance_sq >= reach_sq {
                continue;
            }
            let distance = distance_sq.sqrt();
            let coverage = 1.0 - smoothstep(half, reach, distance);
            if coverage > 0.0 {
                blend_at(data, (row_index + px as usize) * 4, color, clamp(color_alpha * coverage, 0.0, 1.0));
            }
        }
    }
}

fn fill_opaque(data: &mut [u8], r: f64, g: f64, b: f64) {
    let pixel = [to_u8(r), to_u8(g), to_u8(b), 255];
    for chunk in data.chunks_exact_mut(4) {
        chunk.copy_from_slice(&pixel);
    }
}

#[allow(clippy::too_many_arguments)]
fn fill_rect(data: &mut [u8], width: f64, height: f64, left: f64, top: f64, right: f64, bottom: f64, color: Rgba, opacity: f64) {
    let alpha = clamp((color.a / 255.0) * opacity, 0.0, 1.0);
    if alpha <= 0.0 {
        return;
    }
    let start_x = js_max(left.floor(), 0.0);
    let end_x = js_min(right.ceil(), width - 1.0);
    let w = width as usize;
    let (Some((row_from, row_to)), Some((col_from, col_to))) =
        (bounds(js_max(top.floor(), 0.0), js_min(bottom.ceil(), height - 1.0)), bounds(start_x, end_x))
    else {
        return;
    };
    for y in row_from..=row_to {
        let row_index = y as usize * w;
        for x in col_from..=col_to {
            blend_at(data, (row_index + x as usize) * 4, color, alpha);
        }
    }
}

fn draw_circle(data: &mut [u8], width: f64, height: f64, center_x: f64, center_y: f64, radius: f64, color: Rgba) {
    let min_x = (center_x - radius - 1.0).floor();
    let max_x = (center_x + radius + 1.0).ceil();
    let min_y = (center_y - radius - 1.0).floor();
    let max_y = (center_y + radius + 1.0).ceil();
    let (Some((row_from, row_to)), Some((col_from, col_to))) = (bounds(min_y, max_y), bounds(min_x, max_x)) else {
        return;
    };
    for py in row_from..=row_to {
        for px in col_from..=col_to {
            let distance = js_hypot(px as f64 + 0.5 - center_x, py as f64 + 0.5 - center_y);
            let coverage = 1.0 - smoothstep(radius - 0.65, radius + 0.65, distance);
            if coverage > 0.0 {
                blend_pixel(data, width, height, px as f64, py as f64, color, coverage);
            }
        }
    }
}

const AREA_FILL_MAX_OPACITY: f64 = 0.3;
const AREA_FILL_MIN_OPACITY: f64 = 0.02;

/// rasterizer.ts `fillAreaGradient`, from the line's pixel points.
#[allow(clippy::too_many_arguments)]
fn fill_area_gradient(
    data: &mut [u8],
    width: f64,
    height: f64,
    points: &[f64],
    count: usize,
    baseline: f64,
    step: bool,
    color: Rgba,
) {
    let w = width as usize;
    let h = height as usize;
    let mut above = vec![f64::NAN; w];
    let mut below = vec![f64::NAN; w];
    let point = |index: usize| (points[index * 3], points[index * 3 + 1], points[index * 3 + 2] != 0.0);
    for index in 1..count {
        let (cx, cy, break_before) = point(index);
        if break_before {
            continue;
        }
        let (px, py, _) = point(index - 1);
        let (from, to) = if px <= cx { ((px, py), (cx, cy)) } else { ((cx, cy), (px, py)) };
        let start = js_round(from.0);
        let span = js_round(to.0) - start;
        let Some((x_from, x_to)) = bounds(js_max(0.0, start), js_min(width - 1.0, start + span)) else { continue };
        for x in x_from..=x_to {
            let xf = x as f64;
            let y = if step {
                py
            } else if span == 0.0 {
                to.1
            } else {
                from.1 + (to.1 - from.1) * ((xf - start) / span)
            };
            let slot = x as usize;
            if y <= baseline {
                above[slot] = if above[slot].is_nan() { y } else { js_min(above[slot], y) };
            }
            if y >= baseline {
                below[slot] = if below[slot].is_nan() { y } else { js_max(below[slot], y) };
            }
        }
    }

    let floor = js_min(js_max(baseline, 0.0), height - 1.0);
    let mut peak_above = floor;
    let mut peak_below = floor;
    for x in 0..w {
        if !above[x].is_nan() {
            peak_above = js_min(peak_above, above[x]);
        }
        if !below[x].is_nan() {
            peak_below = js_max(peak_below, below[x]);
        }
    }
    let reach_above = js_max(1.0, floor - js_max(0.0, peak_above));
    let reach_below = js_max(1.0, js_min(height - 1.0, peak_below) - floor);

    let color_alpha = color.a / 255.0;
    let spread = AREA_FILL_MAX_OPACITY - AREA_FILL_MIN_OPACITY;
    let mut row_alpha = vec![0.0; h];
    let mut row_red = vec![0.0; h];
    let mut row_green = vec![0.0; h];
    let mut row_blue = vec![0.0; h];
    let mut row_keep = vec![0.0; h];
    for y in 0..h {
        let yf = y as f64;
        let strength = if yf <= floor { (floor - yf) / reach_above } else { (yf - floor) / reach_below };
        let alpha = clamp(color_alpha * (AREA_FILL_MIN_OPACITY + spread * strength), 0.0, 1.0);
        row_alpha[y] = alpha;
        row_red[y] = color.r * alpha;
        row_green[y] = color.g * alpha;
        row_blue[y] = color.b * alpha;
        row_keep[y] = 1.0 - alpha;
    }
    let mut fill_from = vec![f64::INFINITY; w];
    let mut fill_to = vec![f64::NEG_INFINITY; w];
    let mut first_row = floor + 1.0;
    let mut last_row = floor;
    for x in 0..w {
        let top = above[x];
        let bottom = below[x];
        if !top.is_nan() {
            fill_from[x] = js_max(0.0, top.ceil());
            first_row = js_min(first_row, fill_from[x]);
        }
        if !bottom.is_nan() {
            fill_to[x] = js_min(height - 1.0, bottom.floor());
            last_row = js_max(last_row, fill_to[x]);
        }
    }
    // A row that is not a whole number reads and writes nothing in the
    // TypeScript (a typed array ignores fractional indices): skip it.
    let mut y = first_row;
    while y <= last_row {
        if y.fract() == 0.0 && y >= 0.0 && (y as usize) < h {
            let row = y as usize;
            let alpha = row_alpha[row];
            if !(alpha <= 0.0) {
                let keep = row_keep[row];
                let red = row_red[row];
                let green = row_green[row];
                let blue = row_blue[row];
                let above_baseline = y <= floor;
                for x in 0..w {
                    let outside = if above_baseline { y < fill_from[x] } else { y > fill_to[x] };
                    if outside {
                        continue;
                    }
                    let index = (row * w + x) * 4;
                    if data[index + 3] != 255 {
                        blend_at(data, index, color, alpha);
                        continue;
                    }
                    data[index] = to_u8(js_round(red + data[index] as f64 * keep));
                    data[index + 1] = to_u8(js_round(green + data[index + 1] as f64 * keep));
                    data[index + 2] = to_u8(js_round(blue + data[index + 2] as f64 * keep));
                }
            }
        }
        y += 1.0;
    }
}

// ---------------------------------------------------------------------------
// Replaying an op list

/// Replays `ops` into `data`, a `width` x `height` RGBA buffer. Stops at the
/// first op it does not know or that runs past the list.
pub fn replay(data: &mut [u8], width: u32, height: u32, ops: &[f64]) -> bool {
    let width = width as f64;
    let height = height as f64;
    let rgba = |at: usize| Rgba { r: ops[at], g: ops[at + 1], b: ops[at + 2], a: ops[at + 3] };
    let mut at = 0;
    while at < ops.len() {
        let op = ops[at] as u32;
        let needs = match op {
            1 => 4,
            2 => 10,
            3 => 10,
            4 => 8,
            5 => 8,
            6 => 8,
            _ => return false,
        };
        if at + needs > ops.len() {
            return false;
        }
        match op {
            1 => fill_opaque(data, ops[at + 1], ops[at + 2], ops[at + 3]),
            2 => fill_rect(data, width, height, ops[at + 1], ops[at + 2], ops[at + 3], ops[at + 4], rgba(at + 5), ops[at + 9]),
            3 => draw_line(data, width, height, ops[at + 1], ops[at + 2], ops[at + 3], ops[at + 4], rgba(at + 5), ops[at + 9]),
            4 => draw_circle(data, width, height, ops[at + 1], ops[at + 2], ops[at + 3], rgba(at + 4)),
            5 => blend_pixel(data, width, height, ops[at + 1], ops[at + 2], rgba(at + 3), ops[at + 7]),
            6 => {
                let count = ops[at + 1] as usize;
                let start = at + 8;
                if start + count * 3 > ops.len() {
                    return false;
                }
                let color = rgba(at + 4);
                fill_area_gradient(data, width, height, &ops[start..start + count * 3], count, ops[at + 2], ops[at + 3] != 0.0, color);
                at = start + count * 3;
                continue;
            }
            _ => unreachable!(),
        }
        at += needs;
    }
    true
}

// ---------------------------------------------------------------------------
// The WebAssembly interface: JavaScript writes the op list where `ops_buffer`
// points, calls `render`, and reads `width * height * 4` bytes where it
// points. Both buffers live until the next call that grows them.

thread_local! {
    static OPS: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
    static PIXELS: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Room for `count` f64s of op list; returns where to write them.
#[no_mangle]
pub extern "C" fn ops_buffer(count: u32) -> *mut f64 {
    OPS.with(|ops| {
        let mut ops = ops.borrow_mut();
        if ops.len() < count as usize {
            ops.resize(count as usize, 0.0);
        }
        ops.as_mut_ptr()
    })
}

/// Draws the first `count` f64s of the op list into a fresh transparent
/// `width` x `height` buffer; returns where the pixels are, or 0 when the list
/// is malformed.
#[no_mangle]
pub extern "C" fn render(width: u32, height: u32, count: u32) -> *const u8 {
    let size = width as usize * height as usize * 4;
    PIXELS.with(|pixels| {
        let mut pixels = pixels.borrow_mut();
        if pixels.len() < size {
            pixels.resize(size, 0);
        }
        let data = &mut pixels[..size];
        data.fill(0);
        let ok = OPS.with(|ops| {
            let ops = ops.borrow();
            replay(data, width, height, &ops[..(count as usize).min(ops.len())])
        });
        if ok {
            pixels.as_ptr()
        } else {
            core::ptr::null()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_as_javascript() {
        assert_eq!(js_round(0.5), 1.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-0.5), 0.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(to_u8(f64::NAN), 0);
        assert_eq!(to_u8(256.0), 0);
    }

    #[test]
    fn min_max_propagate_nan() {
        assert!(js_max(0.0, f64::NAN).is_nan());
        assert!(js_min(f64::NAN, 1.0).is_nan());
        assert!(clamp(f64::NAN, 0.0, 1.0).is_nan());
    }

    #[test]
    fn hypot_matches_javascript() {
        assert_eq!(js_hypot(3.0, 4.0), 5.0);
        assert_eq!(js_hypot(0.0, 0.0), 0.0);
        assert_eq!(js_hypot(f64::INFINITY, f64::NAN), f64::INFINITY);
    }

    #[test]
    fn replays_a_panel_and_rejects_a_bad_list() {
        let mut data = vec![0u8; 4 * 4 * 4];
        let ops = [1.0, 10.0, 20.0, 30.0, 2.0, 0.0, 0.0, 1.0, 1.0, 255.0, 0.0, 0.0, 255.0, 1.0];
        assert!(replay(&mut data, 4, 4, &ops));
        assert_eq!(&data[0..4], &[255, 0, 0, 255]);
        assert_eq!(&data[8..12], &[10, 20, 30, 255]);
        assert!(!replay(&mut data, 4, 4, &[3.0, 1.0]));
        assert!(!replay(&mut data, 4, 4, &[42.0]));
    }
}
