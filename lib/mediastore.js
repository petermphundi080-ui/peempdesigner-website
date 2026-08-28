const https = require("https");

// Only allow safe, common image formats. SVG is deliberately excluded --
// SVG files can contain embedded <script> tags and are a stored-XSS risk
// if ever opened directly or embedded unsanitized.
const ALLOWED_MIME_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp"
]);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

function validateDataUrl(dataUrl) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
        throw new Error("Invalid image data.");
    }

    const match = dataUrl.match(/^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/);
    if (!match) {
        throw new Error("Invalid image data format.");
    }

    const mimeType = match[1];
    const base64Data = match[2];

    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        throw new Error("Unsupported image type. Please use PNG, JPG, GIF, or WEBP.");
    }

    // Rough size check on the base64 string itself (base64 is ~33% larger
    // than the raw bytes, so this is a slightly generous upper bound --
    // good enough to reject obviously oversized uploads before we even
    // send them to Cloudinary).
    const approxBytes = base64Data.length * 0.75;
    if (approxBytes > MAX_IMAGE_BYTES) {
        throw new Error("Image is too large. Please use a file under 5MB.");
    }
    if (approxBytes === 0) {
        throw new Error("Image data is empty.");
    }

    return true;
}

// Uploads a base64 data URL to Cloudinary and returns the permanent,
// publicly-accessible URL. This replaces saving to local disk, since
// Render's filesystem is wiped on every redeploy -- Cloudinary keeps
// the image available regardless of how many times the server restarts.
function uploadToCloudinary(dataUrl) {
    return new Promise((resolve, reject) => {
        try {
            validateDataUrl(dataUrl);
        } catch (err) {
            reject(err);
            return;
        }

        const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
        const apiKey = process.env.CLOUDINARY_API_KEY;
        const apiSecret = process.env.CLOUDINARY_API_SECRET;

        if (!cloudName || !apiKey || !apiSecret) {
            reject(new Error(
                "Image hosting is not configured. Please set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET."
            ));
            return;
        }

        const authHeader = "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
        const body = "file=" + encodeURIComponent(dataUrl) + "&folder=peempdesigner";

        const options = {
            hostname: "api.cloudinary.com",
            port: 443,
            path: `/v1_1/${cloudName}/image/upload`,
            method: "POST",
            headers: {
                "Authorization": authHeader,
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let responseBody = "";
            res.on("data", (chunk) => { responseBody += chunk; });
            res.on("end", () => {
                let parsed;
                try {
                    parsed = responseBody ? JSON.parse(responseBody) : {};
                } catch (err) {
                    parsed = {};
                }

                if (res.statusCode >= 200 && res.statusCode < 300 && parsed.secure_url) {
                    resolve(parsed.secure_url);
                    return;
                }

                const errorMessage =
                    (parsed.error && parsed.error.message) ||
                    `Cloudinary returned HTTP ${res.statusCode}.`;
                reject(new Error(errorMessage));
            });
        });

        req.setTimeout(20000, () => {
            req.destroy(new Error("Image upload timed out."));
        });

        req.on("error", (error) => {
            reject(error);
        });

        req.write(body);
        req.end();
    });
}

module.exports = {
    uploadToCloudinary,
    MAX_IMAGE_BYTES
};
