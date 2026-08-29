const https = require("https");
const crypto = require("crypto");

/*
   Stores small JSON blobs (like the portfolio projects list) on Cloudinary
   as "raw" files, instead of on the app server's local disk.

   Why: Render's web service filesystem is ephemeral -- anything written
   locally gets reset to whatever's in the last Git deploy every time the
   container redeploys or restarts (which also happens automatically after
   idle periods on the free tier). Cloudinary storage doesn't get touched
   by any of that, so writing our data files there instead makes them
   permanent.

   Reuses the same Cloudinary credentials already set up for image uploads:
     CLOUDINARY_CLOUD_NAME
     CLOUDINARY_API_KEY
     CLOUDINARY_API_SECRET
*/

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

function isConfigured() {
    return Boolean(CLOUD_NAME && API_KEY && API_SECRET);
}

function buildSignature(params, apiSecret) {
    const sortedKeys = Object.keys(params).sort();
    const toSign = sortedKeys
        .map(key => `${key}=${params[key]}`)
        .join("&");

    return crypto
        .createHash("sha1")
        .update(toSign + apiSecret)
        .digest("hex");
}

function httpsRequestJson(options, payload) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let body = "";

            res.on("data", chunk => {
                body += chunk;
            });

            res.on("end", () => {
                let parsed;

                try {
                    parsed = body ? JSON.parse(body) : {};
                } catch {
                    parsed = {};
                }

                resolve({ statusCode: res.statusCode, body: parsed });
            });
        });

        req.setTimeout(15000, () => {
            req.destroy(new Error("Request to Cloudinary timed out."));
        });

        req.on("error", reject);

        if (payload) req.write(payload);
        req.end();
    });
}

function httpsGetText(url) {
    return new Promise((resolve, reject) => {
        https.get(url, res => {
            if (res.statusCode === 404) {
                resolve(null);
                return;
            }

            if (res.statusCode < 200 || res.statusCode >= 300) {
                reject(new Error(`Unexpected response (HTTP ${res.statusCode}) fetching stored data.`));
                return;
            }

            let body = "";

            res.on("data", chunk => {
                body += chunk;
            });

            res.on("end", () => resolve(body));
        }).on("error", reject);
    });
}

/*
   Uploads (or overwrites) a JSON value to Cloudinary as a raw file.

   publicId should be a stable, unique path, e.g.
   "peempdesigner/data/portfolioProjects.json" -- uploading again with the
   same publicId and overwrite:true replaces the previous version rather
   than creating a new file each time.
*/
async function uploadJson(publicId, data) {
    if (!isConfigured()) {
        throw new Error(
            "Remote storage is not configured. Please set CLOUDINARY_CLOUD_NAME, " +
            "CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in Render."
        );
    }

    const jsonString = JSON.stringify(data, null, 2);
    const timestamp = Math.floor(Date.now() / 1000);

    const signature = buildSignature(
        { overwrite: true, public_id: publicId, timestamp },
        API_SECRET
    );

    const base64Data = Buffer.from(jsonString, "utf8").toString("base64");
    const dataUrl = `data:application/json;base64,${base64Data}`;

    const params = new URLSearchParams();
    params.append("file", dataUrl);
    params.append("api_key", API_KEY);
    params.append("timestamp", String(timestamp));
    params.append("public_id", publicId);
    params.append("overwrite", "true");
    params.append("signature", signature);

    const payload = params.toString();

    const options = {
        hostname: "api.cloudinary.com",
        port: 443,
        path: `/v1_1/${CLOUD_NAME}/raw/upload`,
        method: "POST",

        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(payload)
        }
    };

    const { statusCode, body } = await httpsRequestJson(options, payload);

    if (statusCode < 200 || statusCode >= 300 || !body.secure_url) {
        const message =
            (body.error && body.error.message) ||
            `Cloudinary raw upload failed (HTTP ${statusCode}).`;

        throw new Error(message);
    }

    return body.secure_url;
}

/*
   Looks up the current file for publicId via Cloudinary's Admin API (which
   always reports the latest version, avoiding any CDN caching issues), then
   downloads and parses its JSON contents. Returns null if nothing has been
   uploaded under that publicId yet.
*/
async function downloadJson(publicId) {
    if (!isConfigured()) {
        throw new Error(
            "Remote storage is not configured. Please set CLOUDINARY_CLOUD_NAME, " +
            "CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in Render."
        );
    }

    const authHeader =
        "Basic " + Buffer.from(`${API_KEY}:${API_SECRET}`).toString("base64");

    const options = {
        hostname: "api.cloudinary.com",
        port: 443,
        path: `/v1_1/${CLOUD_NAME}/resources/raw/upload/${encodeURIComponent(publicId)}`,
        method: "GET",
        headers: { "Authorization": authHeader }
    };

    const { statusCode, body } = await httpsRequestJson(options, null);

    if (statusCode === 404) {
        return null;
    }

    if (statusCode < 200 || statusCode >= 300 || !body.secure_url) {
        const message =
            (body.error && body.error.message) ||
            `Cloudinary lookup failed (HTTP ${statusCode}).`;

        throw new Error(message);
    }

    const text = await httpsGetText(body.secure_url);
    if (text === null) return null;

    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error(`Stored data for "${publicId}" is corrupted: ${err.message}`);
    }
}

module.exports = {
    isConfigured,
    uploadJson,
    downloadJson
};