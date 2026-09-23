/** @jsxImportSource react */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type Ref } from "react";
import type { Surface3DHostProps } from "../../../../ui/host";
import {
  clampSurface3DCamera, DEFAULT_SURFACE3D_CAMERA, FLOOR, FLOOR_PROJECTION_ALPHA, hitTestSurface3D, projectSurface3D, surface3DBox, surface3DLayout, surface3DLighting,
  surface3DViewport, turbo, SURFACE3D_AMBIENT, SURFACE3D_DIFFUSE, SURFACE3D_SHININESS, SURFACE3D_SPECULAR,
  type Surface3DCamera, type Surface3DScene, type Surface3DViewport,
} from "../../../../components/chart/surface3d/model";
import { colorBarLabels, placeSurface3DLabels, surface3DColorBarGeometry } from "../../../../components/chart/surface3d/software";
import { WebBox } from "./box";

// GLSL ES 1.00 so the same shaders run on WebGL2 and WebGL1 contexts.
const PROJECT = `
uniform vec4 uAngles;   // sinA, cosA, sinE, cosE
uniform vec4 uFit;      // scale, offsetX, offsetY, perspective
uniform vec4 uCanvas;   // centerX, centerY, width, height (CSS px)
vec3 projectPoint(vec3 p) {
  float across = p.x * uAngles.y - p.y * uAngles.x;
  float along = p.x * uAngles.x + p.y * uAngles.y;
  float vertical = p.z * uAngles.w - along * uAngles.z;
  float depth = along * uAngles.w + p.z * uAngles.z;
  float perspective = uFit.w / max(0.5, uFit.w - depth);
  vec2 pixel = vec2(uCanvas.x + (across * perspective - uFit.y) * uFit.x, uCanvas.y + (-vertical * perspective - uFit.z) * uFit.x);
  return vec3(pixel, depth);
}
vec4 clipOf(vec3 projected, float bias) {
  return vec4(projected.x / uCanvas.z * 2.0 - 1.0, 1.0 - projected.y / uCanvas.w * 2.0, clamp(-(projected.z + bias) * 0.25, -1.0, 1.0), 1.0);
}`;

const SURFACE_VERTEX = `
precision highp float;
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec3 aColor;
uniform float uFlatten;
uniform float uFloor;
varying vec3 vNormal;
varying vec3 vColor;
${PROJECT}
void main() {
  vec3 p = aPosition;
  if (uFlatten > 0.5) p.z = uFloor;
  vNormal = aNormal;
  vColor = aColor;
  gl_Position = clipOf(projectPoint(p), 0.0);
}`;

const SURFACE_FRAGMENT = `
precision highp float;
varying vec3 vNormal;
varying vec3 vColor;
uniform float uLit;
uniform float uAlpha;
uniform vec3 uView;
uniform vec3 uLight;
uniform vec3 uHalf;
uniform vec4 uMaterial; // ambient, diffuse, specular, shininess
void main() {
  vec3 color = vColor;
  if (uLit > 0.5) {
    vec3 n = normalize(vNormal);
    if (dot(n, uView) < 0.0) n = -n;
    float diffuse = max(dot(n, uLight), 0.0);
    float specular = pow(max(dot(n, uHalf), 0.0), uMaterial.w) * uMaterial.z;
    color = vColor * (uMaterial.x + uMaterial.y * diffuse) + vec3(specular);
  }
  gl_FragColor = vec4(min(color, vec3(1.0)), uAlpha);
}`;

// Each segment is a quad expanded in screen space; aSide.y runs -1..1 across it.
const LINE_VERTEX = `
precision highp float;
attribute vec3 aStart;
attribute vec3 aEnd;
attribute vec2 aSide;
uniform float uWidth;
uniform float uBias;
varying float vAcross;
${PROJECT}
void main() {
  vec3 a = projectPoint(aStart);
  vec3 b = projectPoint(aEnd);
  vec2 delta = b.xy - a.xy;
  float len = length(delta);
  vec2 dir = len > 1e-4 ? delta / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float halfWidth = uWidth * 0.5 + 1.0;
  vec3 base = mix(a, b, aSide.x);
  vec2 pixel = base.xy + normal * aSide.y * halfWidth + dir * (aSide.x * 2.0 - 1.0) * halfWidth * 0.5;
  vAcross = aSide.y * halfWidth;
  gl_Position = clipOf(vec3(pixel, base.z), uBias);
}`;

const LINE_FRAGMENT = `
precision highp float;
varying float vAcross;
uniform float uWidth;
uniform vec4 uColor;
void main() {
  float coverage = clamp(uWidth * 0.5 + 0.5 - abs(vAcross), 0.0, 1.0);
  gl_FragColor = vec4(uColor.rgb, uColor.a * coverage);
}`;

type GL = WebGLRenderingContext;
const uniformCache = new WeakMap<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
const attributeCache = new WeakMap<WebGLProgram, Map<string, number>>();
function uniform(gl: GL, programHandle: WebGLProgram, name: string): WebGLUniformLocation | null {
  let cache = uniformCache.get(programHandle);
  if (!cache) uniformCache.set(programHandle, cache = new Map());
  if (!cache.has(name)) cache.set(name, gl.getUniformLocation(programHandle, name));
  return cache.get(name)!;
}
function attribute(gl: GL, programHandle: WebGLProgram, name: string): number {
  let cache = attributeCache.get(programHandle);
  if (!cache) attributeCache.set(programHandle, cache = new Map());
  if (!cache.has(name)) cache.set(name, gl.getAttribLocation(programHandle, name));
  return cache.get(name)!;
}
interface LineBuffer { buffer: WebGLBuffer; count: number }
interface Resources {
  gl: GL;
  surface: WebGLProgram;
  line: WebGLProgram;
  positions: WebGLBuffer;
  normals: WebGLBuffer;
  colors: WebGLBuffer;
  indices: WebGLBuffer;
  indexCount: number;
  indexType: number;
  panel: WebGLBuffer;
  wire: LineBuffer;
  ridge: LineBuffer;
  grid: LineBuffer;
  edges: LineBuffer;
  drop: LineBuffer;
  layoutKey: string;
}

function compile(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "Shader compile failed");
  return shader;
}
function program(gl: GL, vertex: string, fragment: string): WebGLProgram {
  const result = gl.createProgram()!;
  gl.attachShader(result, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(result, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(result);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result) ?? "Program link failed");
  return result;
}

/** Six vertices per segment: start, end, and the quad corner offsets. */
function lineVertices(segments: ArrayLike<number>): Float32Array {
  const count = Math.floor(segments.length / 6);
  const data = new Float32Array(count * 6 * 8);
  const corners = [[0, -1], [1, -1], [1, 1], [0, -1], [1, 1], [0, 1]];
  for (let segment = 0; segment < count; segment += 1) {
    for (let corner = 0; corner < 6; corner += 1) {
      const offset = (segment * 6 + corner) * 8;
      for (let k = 0; k < 6; k += 1) data[offset + k] = segments[segment * 6 + k]!;
      data[offset + 6] = corners[corner]![0]!;
      data[offset + 7] = corners[corner]![1]!;
    }
  }
  return data;
}

function uploadLines(gl: GL, target: LineBuffer | null, segments: ArrayLike<number>): LineBuffer {
  const buffer = target?.buffer ?? gl.createBuffer()!;
  const data = lineVertices(segments);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  return { buffer, count: data.length / 8 };
}

function uploadSurfaceGeometry(r: Resources, geometry: SurfaceGeometry): void {
  const { gl } = r;
  gl.bindBuffer(gl.ARRAY_BUFFER, r.positions);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, r.normals);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.normals, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, r.colors);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.colors, gl.DYNAMIC_DRAW);
  r.wire = uploadLines(gl, r.wire, geometry.wire);
  r.ridge = uploadLines(gl, r.ridge, geometry.ridge);
  r.drop = uploadLines(gl, r.drop, geometry.drop);
}

function hexColor(hex: string, alpha = 1): [number, number, number, number] {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value.slice(0, 6);
  const number = Number.parseInt(full, 16);
  if (!Number.isFinite(number)) return [0, 0, 0, alpha];
  return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255, alpha];
}
function mix(a: string, b: string, weight: number): [number, number, number] {
  const x = hexColor(a), y = hexColor(b);
  return [x[0] + (y[0] - x[0]) * weight, x[1] + (y[1] - x[1]) * weight, x[2] + (y[2] - x[2]) * weight];
}

const cameraEquals = (a: Surface3DCamera, b: Surface3DCamera) =>
  Math.abs(a.azimuth - b.azimuth) < 1e-6 && Math.abs(a.elevation - b.elevation) < 1e-6 && Math.abs(a.zoom - b.zoom) < 1e-6;
const angleDelta = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

/** How long a refreshed surface takes to settle into its new shape. */
export const SURFACE_MORPH_MS = 650;

/** The vertex data drawn on screen, kept so a refreshed scene can morph from it. */
export interface SurfaceGeometry {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  wire: Float32Array;
  ridge: Float32Array;
  drop: Float32Array;
  indices: Uint32Array;
}

export function surfaceGeometry(scene: Surface3DScene, drop: ArrayLike<number>): SurfaceGeometry {
  // Missing cells are NaN in the scene and are never indexed; draw them at 0.
  const positions = new Float32Array(scene.positions.length);
  for (let index = 0; index < positions.length; index += 1) {
    const value = scene.positions[index]!;
    positions[index] = Number.isFinite(value) ? value : 0;
  }
  return {
    positions, normals: Float32Array.from(scene.normals), colors: Float32Array.from(scene.colors),
    wire: Float32Array.from(scene.wire), ridge: Float32Array.from(scene.ridge), drop: Float32Array.from(drop), indices: scene.indices,
  };
}

function cloneGeometry(geometry: SurfaceGeometry): SurfaceGeometry {
  return {
    positions: geometry.positions.slice(), normals: geometry.normals.slice(), colors: geometry.colors.slice(),
    wire: geometry.wire.slice(), ridge: geometry.ridge.slice(), drop: geometry.drop.slice(), indices: geometry.indices,
  };
}

function sameValues(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/**
 * A refresh can morph only when it draws the same mesh: same grid, same valid
 * cells and the same line layout. A different expiry set or a cell that gained
 * or lost a quote swaps in directly.
 */
export function canMorphSurface(from: SurfaceGeometry, to: SurfaceGeometry): boolean {
  return from.positions.length === to.positions.length && from.normals.length === to.normals.length
    && from.colors.length === to.colors.length && from.wire.length === to.wire.length
    && from.ridge.length === to.ridge.length && sameValues(from.indices, to.indices)
    && !(sameValues(from.positions, to.positions) && sameValues(from.colors, to.colors));
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

function lerpInto(out: Float32Array, from: Float32Array, to: Float32Array, weight: number): void {
  for (let index = 0; index < out.length; index += 1) out[index] = from[index]! + (to[index]! - from[index]!) * weight;
}

/** Writes the morph frame at progress t (0..1) into out. */
export function morphSurfaceGeometry(out: SurfaceGeometry, from: SurfaceGeometry, to: SurfaceGeometry, t: number): void {
  const weight = easeOutCubic(Math.min(1, Math.max(0, t)));
  lerpInto(out.positions, from.positions, to.positions, weight);
  lerpInto(out.normals, from.normals, to.normals, weight);
  lerpInto(out.colors, from.colors, to.colors, weight);
  lerpInto(out.wire, from.wire, to.wire, weight);
  lerpInto(out.ridge, from.ridge, to.ridge, weight);
  if (out.drop.length === to.drop.length && from.drop.length === to.drop.length) lerpInto(out.drop, from.drop, to.drop, weight);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * WebGL surface chart. React renders it once per scene or palette change; every
 * camera frame (drag, inertia, zoom, tweens) is drawn in requestAnimationFrame
 * against uploaded buffers, and labels move by transform without re-rendering.
 */
export function WebSurface3D(props: Surface3DHostProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelLayerRef = useRef<HTMLDivElement | null>(null);
  const markerRef = useRef<HTMLDivElement | null>(null);
  const resources = useRef<Resources | null>(null);
  const [failed, setFailed] = useState(false);
  const state = useRef({
    camera: clampSurface3DCamera(props.camera),
    target: null as Surface3DCamera | null,
    velocity: { azimuth: 0, elevation: 0 },
    zoomTarget: null as number | null,
    drag: null as null | { pointerId: number; x: number; y: number; lastX: number; lastY: number; lastTime: number; moved: boolean },
    frame: 0,
    commitTimer: 0 as ReturnType<typeof setTimeout> | 0,
    committed: clampSurface3DCamera(props.camera),
    size: { width: 1, height: 1, ratio: 1 },
    shown: null as SurfaceGeometry | null,
    morph: null as null | { from: SurfaceGeometry; to: SurfaceGeometry; start: number },
  });
  const propsRef = useRef(props);
  propsRef.current = props;

  const viewportFor = (camera: Surface3DCamera): Surface3DViewport =>
    surface3DViewport(state.current.size.width, state.current.size.height, camera, propsRef.current.scene.top, propsRef.current.reserveRight);

  const commit = (delay = 0) => {
    const s = state.current;
    if (s.commitTimer) clearTimeout(s.commitTimer);
    s.commitTimer = setTimeout(() => {
      s.commitTimer = 0;
      if (cameraEquals(s.camera, s.committed)) return;
      s.committed = s.camera;
      propsRef.current.onCameraChange(s.camera);
    }, delay);
  };

  const draw = () => {
    const r = resources.current, canvas = canvasRef.current;
    if (!r || !canvas) return;
    const { gl } = r;
    const s = state.current, p = propsRef.current;
    const viewport = viewportFor(s.camera);
    const layout = surface3DLayout(viewport);
    const layoutKey = `${layout.farX}:${layout.farY}`;
    if (layoutKey !== r.layoutKey) {
      const box = surface3DBox(p.scene, layout);
      const panels: number[] = [];
      for (const quad of box.panels) for (const index of [0, 1, 2, 0, 2, 3]) panels.push(quad[index]!.x, quad[index]!.y, quad[index]!.z);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.panel);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(panels), gl.DYNAMIC_DRAW);
      r.grid = uploadLines(gl, r.grid, box.grid);
      r.edges = uploadLines(gl, r.edges, box.edges);
      r.layoutKey = layoutKey;
    }
    const ratio = s.size.ratio;
    gl.viewport(0, 0, canvas.width, canvas.height);
    const bg = hexColor(p.colors.bg);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const { view, light, halfway } = surface3DLighting(viewport);
    const setProjection = (programHandle: WebGLProgram) => {
      gl.uniform4f(uniform(gl, programHandle, "uAngles"), viewport.sinA, viewport.cosA, viewport.sinE, viewport.cosE);
      gl.uniform4f(uniform(gl, programHandle, "uFit"), viewport.scale, viewport.offsetX, viewport.offsetY, 5.8);
      gl.uniform4f(uniform(gl, programHandle, "uCanvas"), viewport.centerX, viewport.centerY, viewport.width, viewport.height);
    };

    // Surface program: panels (flat), floor projection, lit surface.
    gl.useProgram(r.surface);
    setProjection(r.surface);
    const aPosition = attribute(gl, r.surface, "aPosition");
    const aNormal = attribute(gl, r.surface, "aNormal");
    const aColor = attribute(gl, r.surface, "aColor");
    const uLit = uniform(gl, r.surface, "uLit"), uAlpha = uniform(gl, r.surface, "uAlpha");
    const uFlatten = uniform(gl, r.surface, "uFlatten");
    gl.uniform1f(uniform(gl, r.surface, "uFloor"), FLOOR);
    gl.uniform3f(uniform(gl, r.surface, "uView"), view.x, view.y, view.z);
    gl.uniform3f(uniform(gl, r.surface, "uLight"), light.x, light.y, light.z);
    gl.uniform3f(uniform(gl, r.surface, "uHalf"), halfway.x, halfway.y, halfway.z);
    gl.uniform4f(uniform(gl, r.surface, "uMaterial"), SURFACE3D_AMBIENT, SURFACE3D_DIFFUSE, SURFACE3D_SPECULAR, SURFACE3D_SHININESS);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.bindBuffer(gl.ARRAY_BUFFER, r.panel);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(aNormal);
    gl.vertexAttrib3f(aNormal, 0, 0, 1);
    gl.disableVertexAttribArray(aColor);
    const panel = mix(p.colors.bg, p.colors.grid, 0.32);
    gl.vertexAttrib3f(aColor, panel[0], panel[1], panel[2]);
    gl.uniform1f(uLit, 0);
    gl.uniform1f(uAlpha, 1);
    gl.uniform1f(uFlatten, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 18);

    // Box grid and edges under everything else.
    const drawLines = (lines: LineBuffer, width: number, color: [number, number, number, number], depthTest: boolean, bias = 0) => {
      if (!lines.count) return;
      gl.useProgram(r.line);
      setProjection(r.line);
      gl.uniform1f(uniform(gl, r.line, "uWidth"), width * ratio);
      gl.uniform1f(uniform(gl, r.line, "uBias"), bias);
      gl.uniform4f(uniform(gl, r.line, "uColor"), ...color);
      if (depthTest) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false); } else gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindBuffer(gl.ARRAY_BUFFER, lines.buffer);
      const start = attribute(gl, r.line, "aStart"), end = attribute(gl, r.line, "aEnd"), side = attribute(gl, r.line, "aSide");
      gl.enableVertexAttribArray(start); gl.vertexAttribPointer(start, 3, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(end); gl.vertexAttribPointer(end, 3, gl.FLOAT, false, 32, 12);
      gl.enableVertexAttribArray(side); gl.vertexAttribPointer(side, 2, gl.FLOAT, false, 32, 24);
      gl.drawArrays(gl.TRIANGLES, 0, lines.count);
      gl.disableVertexAttribArray(start); gl.disableVertexAttribArray(end); gl.disableVertexAttribArray(side);
      gl.depthMask(true);
    };
    const gridColor = mix(p.colors.bg, p.colors.axis, 0.3), edgeColor = mix(p.colors.bg, p.colors.axis, 0.55);
    drawLines(r.grid, 1, [...gridColor, 0.9], false);
    drawLines(r.edges, 1.3, [...edgeColor, 1], false);

    // Floor projection, then the lit surface with depth.
    gl.useProgram(r.surface);
    gl.bindBuffer(gl.ARRAY_BUFFER, r.positions);
    gl.enableVertexAttribArray(aPosition); gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, r.normals);
    gl.enableVertexAttribArray(aNormal); gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, r.colors);
    gl.enableVertexAttribArray(aColor); gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, r.indices);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(uLit, 0); gl.uniform1f(uAlpha, FLOOR_PROJECTION_ALPHA); gl.uniform1f(uFlatten, 1);
    gl.drawElements(gl.TRIANGLES, r.indexCount, r.indexType, 0);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1);
    gl.uniform1f(uLit, 1); gl.uniform1f(uAlpha, 1); gl.uniform1f(uFlatten, 0);
    gl.drawElements(gl.TRIANGLES, r.indexCount, r.indexType, 0);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disableVertexAttribArray(aNormal); gl.disableVertexAttribArray(aColor);

    drawLines(r.wire, 0.9, [8 / 255, 10 / 255, 18 / 255, 0.42], true, 0.01);
    const ridge = hexColor(p.colors.ridge);
    drawLines(r.ridge, 6, [ridge[0], ridge[1], ridge[2], 0.26], true, 0.02);
    drawLines(r.ridge, 2, [ridge[0], ridge[1], ridge[2], 1], true, 0.02);
    drawLines(r.drop, 1, [1, 1, 1, 0.55], false);

    // Labels and the selected marker follow the camera by transform only.
    const layer = labelLayerRef.current;
    if (layer) {
      const placed = placeSurface3DLabels(p.scene, viewport, 1, p.colors);
      if (p.reserveRight > 0) placed.push(...colorBarLabels(p.scene, viewport.width, viewport.height, p.reserveRight, 1, p.colors));
      const existing = new Map<string, HTMLElement>();
      for (const child of Array.from(layer.children) as HTMLElement[]) existing.set(child.dataset.key ?? "", child);
      for (const label of placed) {
        let element = existing.get(label.key);
        if (!element) {
          element = document.createElement("span");
          element.dataset.key = label.key;
          Object.assign(element.style, { position: "absolute", left: "0", top: "0", whiteSpace: "pre", pointerEvents: "none",
            textShadow: "0 1px 2px rgba(0,0,0,0.85)", willChange: "transform" } satisfies Partial<CSSStyleDeclaration>);
          layer.appendChild(element);
        }
        existing.delete(label.key);
        if (element.textContent !== label.text) element.textContent = label.text;
        element.style.color = label.color;
        element.style.fontSize = label.role === "title" ? "11px" : "12px";
        element.style.fontWeight = label.role === "tick" ? "400" : "600";
        element.style.letterSpacing = label.role === "title" ? "0.08em" : "normal";
        const shiftX = label.align === "left" ? "0%" : label.align === "right" ? "-100%" : "-50%";
        element.style.transform = `translate(${label.anchorX}px, ${label.anchorY}px) translate(${shiftX}, -50%)`;
      }
      for (const stale of existing.values()) stale.remove();
    }
    const marker = markerRef.current;
    const selected = p.scene.input.selected ? p.scene.nodes.find((point) => point.row === p.scene.input.selected!.row && point.column === p.scene.input.selected!.column) : null;
    if (marker) {
      if (selected) {
        const at = projectSurface3D(selected, viewport);
        marker.style.display = "block";
        marker.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -50%)`;
      } else marker.style.display = "none";
    }
  };

  const schedule = () => {
    const s = state.current;
    if (s.frame) return;
    s.frame = requestAnimationFrame(tick);
  };
  const tick = () => {
    const s = state.current;
    s.frame = 0;
    let animating = false;
    if (!s.drag && (Math.abs(s.velocity.azimuth) > 1e-4 || Math.abs(s.velocity.elevation) > 1e-4)) {
      s.camera = clampSurface3DCamera({ ...s.camera, azimuth: s.camera.azimuth + s.velocity.azimuth, elevation: s.camera.elevation + s.velocity.elevation });
      s.velocity = { azimuth: s.velocity.azimuth * 0.92, elevation: s.velocity.elevation * 0.88 };
      animating = true;
      if (Math.abs(s.velocity.azimuth) <= 1e-4 && Math.abs(s.velocity.elevation) <= 1e-4) commit(120);
    }
    if (s.zoomTarget != null) {
      const zoom = s.camera.zoom + (s.zoomTarget - s.camera.zoom) * 0.28;
      s.camera = clampSurface3DCamera({ ...s.camera, zoom: Math.abs(zoom - s.zoomTarget) < 1e-3 ? s.zoomTarget : zoom });
      if (s.camera.zoom === s.zoomTarget) { s.zoomTarget = null; commit(200); } else animating = true;
    }
    if (s.target && !s.drag) {
      const target = s.target;
      const next = { azimuth: s.camera.azimuth + angleDelta(s.camera.azimuth, target.azimuth) * 0.3,
        elevation: s.camera.elevation + (target.elevation - s.camera.elevation) * 0.3, zoom: s.camera.zoom + (target.zoom - s.camera.zoom) * 0.3 };
      const done = Math.abs(angleDelta(next.azimuth, target.azimuth)) < 1e-3 && Math.abs(next.elevation - target.elevation) < 1e-3 && Math.abs(next.zoom - target.zoom) < 1e-3;
      s.camera = clampSurface3DCamera(done ? target : next);
      if (done) { s.target = null; commit(); } else animating = true;
    }
    if (s.morph && s.shown && resources.current) {
      const t = (performance.now() - s.morph.start) / SURFACE_MORPH_MS;
      morphSurfaceGeometry(s.shown, s.morph.from, s.morph.to, t);
      uploadSurfaceGeometry(resources.current, s.shown);
      if (t >= 1) s.morph = null; else animating = true;
    }
    draw();
    if (animating) schedule();
  };

  // GL context and programs live for the component's lifetime.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const options = { antialias: true, alpha: false, depth: true, preserveDrawingBuffer: true, premultipliedAlpha: false } as const;
    const gl = (canvas.getContext("webgl2", options) ?? canvas.getContext("webgl", options)) as GL | null;
    if (!gl) { setFailed(true); return; }
    const webgl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
    const uint32 = webgl2 || !!gl.getExtension("OES_element_index_uint");
    try {
      resources.current = {
        gl, surface: program(gl, SURFACE_VERTEX, SURFACE_FRAGMENT), line: program(gl, LINE_VERTEX, LINE_FRAGMENT),
        positions: gl.createBuffer()!, normals: gl.createBuffer()!, colors: gl.createBuffer()!, indices: gl.createBuffer()!,
        indexCount: 0, indexType: uint32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, panel: gl.createBuffer()!,
        wire: { buffer: gl.createBuffer()!, count: 0 }, ridge: { buffer: gl.createBuffer()!, count: 0 },
        grid: { buffer: gl.createBuffer()!, count: 0 }, edges: { buffer: gl.createBuffer()!, count: 0 },
        drop: { buffer: gl.createBuffer()!, count: 0 }, layoutKey: "",
      };
    } catch {
      setFailed(true);
      return;
    }
    const lost = (event: Event) => { event.preventDefault(); setFailed(true); };
    canvas.addEventListener("webglcontextlost", lost);
    return () => {
      canvas.removeEventListener("webglcontextlost", lost);
      if (state.current.frame) cancelAnimationFrame(state.current.frame);
      if (state.current.commitTimer) clearTimeout(state.current.commitTimer);
      resources.current = null;
    };
  }, []);

  // Geometry uploads once per scene. A refresh of the same mesh (new quotes on
  // the same grid) morphs from what is on screen instead of jumping.
  useEffect(() => {
    const r = resources.current;
    if (!r) return;
    const s = state.current;
    const scene = props.scene;
    const chosen = scene.input.selected ? scene.nodes.find((point) => point.row === scene.input.selected!.row && point.column === scene.input.selected!.column) : null;
    const next = surfaceGeometry(scene, chosen ? [chosen.x, chosen.y, chosen.z, chosen.x, chosen.y, FLOOR] : []);
    if (s.shown && !prefersReducedMotion() && canMorphSurface(s.shown, next)) {
      if (s.shown.drop.length !== next.drop.length) s.shown.drop = next.drop.slice();
      s.morph = { from: cloneGeometry(s.shown), to: next, start: performance.now() };
    } else {
      s.morph = null;
      s.shown = cloneGeometry(next);
      const { gl } = r;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, r.indices);
      const indices = r.indexType === gl.UNSIGNED_INT ? scene.indices : Uint16Array.from(scene.indices.filter((index) => index < 65536));
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      r.indexCount = indices.length;
      uploadSurfaceGeometry(r, s.shown);
    }
    r.layoutKey = "";
    schedule();
  }, [props.scene, failed]);

  useEffect(() => { schedule(); }, [props.colors, props.reserveRight]);

  // External camera changes (keyboard, reset, restored state) tween in.
  useEffect(() => {
    const s = state.current;
    const next = clampSurface3DCamera(props.camera);
    if (cameraEquals(next, s.committed)) return;
    s.committed = next;
    if (s.drag) return;
    s.velocity = { azimuth: 0, elevation: 0 };
    s.zoomTarget = null;
    s.target = next;
    schedule();
  }, [props.camera.azimuth, props.camera.elevation, props.camera.zoom]);

  // Drawing buffer follows the element size at device resolution.
  useLayoutEffect(() => {
    const container = containerRef.current, canvas = canvasRef.current;
    if (!container || !canvas) return;
    const resize = () => {
      const rect = container.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, rect.width), height = Math.max(1, rect.height);
      state.current.size = { width, height, ratio };
      const pixelWidth = Math.max(1, Math.round(width * ratio)), pixelHeight = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
      draw();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [failed]);

  // Native, non-passive wheel so zooming never scrolls the surrounding page.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const s = state.current;
      // Trackpad pinch arrives as ctrl+wheel with small deltas.
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const base = s.zoomTarget ?? s.camera.zoom;
      s.zoomTarget = clampSurface3DCamera({ ...s.camera, zoom: base * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0016)) }).zoom;
      schedule();
    };
    container.addEventListener("wheel", wheel, { passive: false });
    return () => container.removeEventListener("wheel", wheel);
  }, [failed]);

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  if (failed) return <>{props.fallback ?? null}</>;
  const bar = surface3DColorBarGeometry(1000, 1000, props.reserveRight, 1);
  const stops = Array.from({ length: 11 }, (_, index) => {
    const color = turbo(1 - index / 10);
    return `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}) ${index * 10}%`;
  }).join(", ");
  return (
    <WebBox width={props.width} height={props.height} data-gloom-role="surface-3d"
      style={{ position: "relative", overflow: "hidden", touchAction: "none", overscrollBehavior: "none" }}>
    <div
      ref={containerRef as Ref<HTMLDivElement>}
      aria-label={props.ariaLabel}
      role="img"
      style={{ position: "absolute", inset: 0, overflow: "hidden", touchAction: "none", cursor: "grab", userSelect: "none" }}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        const s = state.current, at = local(event);
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        s.velocity = { azimuth: 0, elevation: 0 };
        s.target = null;
        s.drag = { pointerId: event.pointerId, x: at.x, y: at.y, lastX: at.x, lastY: at.y, lastTime: performance.now(), moved: false };
        (event.currentTarget as HTMLElement).style.cursor = "grabbing";
      }}
      onPointerMove={(event: ReactPointerEvent<HTMLDivElement>) => {
        const s = state.current, drag = s.drag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const at = local(event);
        if (!drag.moved && Math.hypot(at.x - drag.x, at.y - drag.y) < 3) return;
        drag.moved = true;
        const dx = at.x - drag.lastX, dy = at.y - drag.lastY, now = performance.now();
        const step = { azimuth: -dx * 0.0085, elevation: dy * 0.0065 };
        s.camera = clampSurface3DCamera({ ...s.camera, azimuth: s.camera.azimuth + step.azimuth, elevation: s.camera.elevation + step.elevation });
        // Velocity per 16ms frame, smoothed, for inertia after release.
        const frames = Math.max(1, (now - drag.lastTime) / 16);
        s.velocity = { azimuth: s.velocity.azimuth * 0.5 + step.azimuth / frames * 0.5, elevation: s.velocity.elevation * 0.5 + step.elevation / frames * 0.5 };
        drag.lastX = at.x; drag.lastY = at.y; drag.lastTime = now;
        schedule();
      }}
      onPointerUp={(event: ReactPointerEvent<HTMLDivElement>) => {
        const s = state.current, drag = s.drag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        s.drag = null;
        (event.currentTarget as HTMLElement).style.cursor = "grab";
        if (!drag.moved) {
          const at = local(event);
          const cell = hitTestSurface3D(propsRef.current.scene, viewportFor(s.camera), at.x, at.y, 16);
          if (cell) propsRef.current.onSelect(cell);
          return;
        }
        // A pause before release means no fling.
        if (performance.now() - drag.lastTime > 80) s.velocity = { azimuth: 0, elevation: 0 };
        if (Math.abs(s.velocity.azimuth) > 1e-4 || Math.abs(s.velocity.elevation) > 1e-4) schedule();
        else commit();
      }}
      onPointerCancel={() => { state.current.drag = null; commit(); }}
      onDoubleClick={() => { const s = state.current; s.velocity = { azimuth: 0, elevation: 0 }; s.target = { ...DEFAULT_SURFACE3D_CAMERA }; schedule(); }}
    >
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} />
      {props.reserveRight > 0 ? <div style={{ position: "absolute", left: `${bar.x / 10}%`, top: `${bar.top / 10}%`, width: 8,
        height: `${(bar.bottom - bar.top) / 10}%`, background: `linear-gradient(to bottom, ${stops})`, borderRadius: 2, pointerEvents: "none" }} /> : null}
      <div ref={labelLayerRef} style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2 }} />
      <div ref={markerRef} style={{ position: "absolute", left: 0, top: 0, width: 12, height: 12, borderRadius: 12, display: "none",
        border: "2px solid #ffffff", background: "#10121c", boxShadow: "0 0 0 6px rgba(255,255,255,0.14)", pointerEvents: "none", zIndex: 3 }} />
    </div>
    </WebBox>
  );
}
