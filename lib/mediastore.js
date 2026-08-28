const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const IMAGES_DIR = path.join(__dirname, "..", "images", "uploads");

// Only allow safe, common image formats. SVG is deliberately excluded --
// SVG files can contain embedded <script> tags and are a stored-XSS risk
// if ever opened directly or embedded unsanitized.
const ALLOWED_MIME_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp"
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

function ensureDir() {
    if (!fs.existsSync(IMAGES_DIR)) {
        fs.mkdirSync(IMAGES_DIR, { recursive: true });
    }
}

// Accepts a data URL like "data:image/png;base64,AAAA..." and saves it to
// disk. Returns the public URL path to use in <img src="..."> or as a
// stored field value (e.g. "/images/uploads/abc123.png").
function saveBase64Image(dataUrl) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
        throw new Error("Invalid image data.");
    }

    const match = dataUrl.match(/^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/);
    if (!match) {
        throw new Error("Invalid image data format.");
    }

    const mimeType = match[1];
    const base64Data = match[2];
    const extension = ALLOWED_MIME_TYPES[mimeType];

    if (!extension) {
        throw new Error("Unsupported image type. Please use PNG, JPG, GIF, or WEBP.");
    }

    const buffer = Buffer.from(base64Data, "base64");

    if (buffer.length === 0) {
        throw new Error("Image data is empty.");
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error("Image is too large. Please use a file under 5MB.");
    }

    ensureDir();

    const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${extension}`;
    const filePath = path.join(IMAGES_DIR, filename);

    fs.writeFileSync(filePath, buffer);

    return `/images/uploads/${filename}`;
}

// Validate a pasted URL is at least a plausible absolute URL before storing
// it as a field value. This is not a guarantee the URL is safe or reachable,
// just a basic sanity check to catch obvious mistakes.
function isValidImageUrl(value) {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    // Allow absolute http(s) URLs, or our own relative uploaded-image paths
    return /^https?:\/\/.+/i.test(trimmed) || /^\/images\/.+/i.test(trimmed);
}

module.exports = {
    saveBase64Image,
    isValidImageUrl,
    MAX_IMAGE_BYTES
};
