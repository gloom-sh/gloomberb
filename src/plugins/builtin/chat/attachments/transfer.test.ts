import { describe, expect, test } from "bun:test";
import { clipboardAttachments, insertedText, pastedImagePaths, transferFiles, type TransferData, type TransferFile } from "./transfer";

function file(name: string, type = "image/png"): TransferFile {
  return { name, type, size: 10 };
}

function clipboard(files: TransferFile[], text = "", viaItems = false): TransferData {
  return {
    files: viaItems ? [] : files,
    items: files.map((entry) => ({ kind: "file", type: entry.type, getAsFile: () => entry })),
    types: [...(files.length > 0 ? ["Files"] : []), ...(text ? ["text/plain"] : [])],
    getData: (format) => (format === "text/plain" ? text : ""),
  };
}

describe("clipboard and drop files", () => {
  test("a screenshot attaches; a spreadsheet copy that also has text pastes its text", () => {
    const shot = file("image.png");
    expect(clipboardAttachments(clipboard([shot]))).toEqual([shot]);
    // Some browsers list the pasted image only as an item.
    expect(clipboardAttachments(clipboard([shot], "", true))).toEqual([shot]);
    expect(clipboardAttachments(clipboard([shot], "SPY\t512.3\nQQQ\t441.2"))).toBeNull();
    expect(clipboardAttachments(clipboard([], "just text"))).toBeNull();
  });

  test("a file copied in a file manager attaches although its name rides along as text", () => {
    const copied = file("chart.png");
    expect(clipboardAttachments(clipboard([copied], "chart.png"))).toEqual([copied]);
    expect(clipboardAttachments(clipboard([copied], "/Users/v/Desktop/chart.png"))).toEqual([copied]);
  });

  test("a drop keeps every file, so the upload checks can name the ones that are not images", () => {
    const files = [file("a.png"), file("notes.pdf", "application/pdf")];
    expect(transferFiles(clipboard(files))).toEqual(files);
  });
});

describe("paths pasted or dropped into the terminal", () => {
  test("reads the forms terminals type for a dropped file", () => {
    expect(pastedImagePaths("/Users/v/Desktop/Screen\\ Shot\\ 1.png ")).toEqual(["/Users/v/Desktop/Screen Shot 1.png"]);
    expect(pastedImagePaths("'/Users/v/My Shot.JPG'")).toEqual(["/Users/v/My Shot.JPG"]);
    expect(pastedImagePaths("file:///home/v/a%20b.webp")).toEqual(["/home/v/a b.webp"]);
    expect(pastedImagePaths("\"C:\\Users\\v\\shot.gif\"")).toEqual(["C:\\Users\\v\\shot.gif"]);
    expect(pastedImagePaths("~/a.png /tmp/b.jpeg")).toEqual(["~/a.png", "/tmp/b.jpeg"]);
  });

  test("leaves ordinary text alone", () => {
    expect(pastedImagePaths("look at /tmp/a.png")).toBeNull();
    expect(pastedImagePaths("/tmp/report.pdf")).toBeNull();
    expect(pastedImagePaths("a.png")).toBeNull();
    expect(pastedImagePaths("'/tmp/unclosed.png")).toBeNull();
  });

  test("finds what one edit inserted, and only for a pure insertion", () => {
    expect(insertedText("see ", "see /a.png ")).toEqual({ start: 4, text: "/a.png " });
    expect(insertedText("ab", "a/x.pngb")).toEqual({ start: 1, text: "/x.png" });
    expect(insertedText("abc", "ab")).toBeNull();
    expect(insertedText("abc", "xyz1")).toBeNull();
  });
});
