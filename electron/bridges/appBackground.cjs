"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const IMAGE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg)$/;

// Inspect dimensions before asking the native decoder to allocate a bitmap.
function inspectImage(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString("ascii", 12, 16) === "IHDR") {
    return { extension: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        return { extension: "jpg", width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  throw new Error("Choose a valid PNG or JPEG image.");
}

function validateImage(bytes, nativeImage) {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("Background image must be at most 10 MiB.");
  const info = inspectImage(bytes);
  if (!info.width || !info.height || info.width * info.height > MAX_PIXELS) {
    throw new Error("Background image must contain at most 40 million pixels.");
  }
  const decoded = nativeImage.createFromBuffer(bytes);
  const size = decoded.getSize();
  if (decoded.isEmpty() || !size.width || !size.height || size.width * size.height > MAX_PIXELS) {
    throw new Error("Background image could not be decoded.");
  }
  return info;
}

function createAppBackgroundService({ directory, nativeImage, selectFile, fsImpl = fs }) {
  function imagePath(imageId) {
    if (typeof imageId !== "string" || !IMAGE_ID.test(imageId)) throw new Error("Invalid background image ID.");
    return path.join(directory, imageId);
  }
  async function readBounded(filePath) {
    const file = await fsImpl.open(filePath, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Background image must be at most 10 MiB.");
      // A bounded read also handles files growing after stat().
      const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1));
      let length = 0;
      while (length < buffer.length) {
        const result = await file.read(buffer, length, buffer.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > stat.size) throw new Error("Background image changed during import.");
      return buffer.subarray(0, length);
    } finally { await file.close(); }
  }
  return {
    async importImage(event) {
      const source = await selectFile(event);
      if (!source) return null;
      const bytes = await readBounded(source);
      const { extension } = validateImage(bytes, nativeImage);
      const imageId = `${randomUUID()}.${extension}`;
      await fsImpl.mkdir(directory, { recursive: true });
      try {
        await fsImpl.writeFile(imagePath(imageId), bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        // A failed write must not leave an unused partial asset behind.
        if (error.code !== "EEXIST") await fsImpl.rm(imagePath(imageId), { force: true }).catch(() => {});
        throw error;
      }
      return { imageId };
    },
    async load(imageId) {
      const target = imagePath(imageId);
      try {
        const stat = await fsImpl.lstat(target);
        if (stat.isSymbolicLink()) throw new Error("Invalid background image file.");
        const bytes = await readBounded(target);
        const { extension } = validateImage(bytes, nativeImage);
        return `data:image/${extension === "jpg" ? "jpeg" : "png"};base64,${bytes.toString("base64")}`;
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async remove(imageId) {
      await fsImpl.rm(imagePath(imageId), { force: true });
    },
  };
}

function registerAppBackgroundHandlers({ ipcMain, app, nativeImage, dialog, BrowserWindow, isTrustedSender }) {
  const service = createAppBackgroundService({
    directory: path.join(app.getPath("userData"), "backgrounds"),
    nativeImage,
    selectFile: async (event) => {
      const options = { properties: ["openFile"], filters: [{ name: "PNG / JPEG", extensions: ["png", "jpg", "jpeg"] }] };
      const parent = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(...(parent ? [parent, options] : [options]));
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  });
  for (const [operation, method] of [["import", "importImage"], ["load", "load"], ["remove", "remove"]]) {
    ipcMain.handle(`netcatty:app-background:${operation}`, async (event, imageId) => {
      if (!isTrustedSender(event)) throw new Error("Untrusted background request.");
      return method === "importImage" ? service.importImage(event) : service[method](imageId);
    });
  }
}

module.exports = { createAppBackgroundService, registerAppBackgroundHandlers, inspectImage, MAX_BYTES, MAX_PIXELS };
