const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const CONTENT_FILE = path.join(DATA_DIR, "content.json");

function ensureFile() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(CONTENT_FILE)) {
        fs.writeFileSync(CONTENT_FILE, "[]", "utf8");
    }
}

function readContent() {
    ensureFile();
    const raw = fs.readFileSync(CONTENT_FILE, "utf8");
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error("content.json is corrupted, resetting to empty list:", err);
        return [];
    }
}

function writeContent(items) {
    ensureFile();
    fs.writeFileSync(CONTENT_FILE, JSON.stringify(items, null, 2), "utf8");
}

function getAllContent() {
    // Most recently created first, easiest for an admin list view
    return readContent().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function getContentById(id) {
    return readContent().find(item => item.id === id) || null;
}

function createContent({ title, body }) {
    title = typeof title === "string" ? title.trim() : "";
    body = typeof body === "string" ? body.trim() : "";

    if (!title) throw new Error("Title is required.");
    if (!body) throw new Error("Body is required.");

    const items = readContent();

    const newItem = {
        id: crypto.randomBytes(8).toString("hex"),
        title,
        body,
        created_at: new Date().toISOString()
    };

    items.push(newItem);
    writeContent(items);
    return newItem;
}

function updateContent(id, { title, body }) {
    const items = readContent();
    const index = items.findIndex(item => item.id === id);
    if (index === -1) throw new Error("Content item not found.");

    const existing = items[index];

    if (title !== undefined) {
        title = typeof title === "string" ? title.trim() : "";
        if (!title) throw new Error("Title cannot be empty.");
        existing.title = title;
    }

    if (body !== undefined) {
        body = typeof body === "string" ? body.trim() : "";
        if (!body) throw new Error("Body cannot be empty.");
        existing.body = body;
    }

    existing.updated_at = new Date().toISOString();

    items[index] = existing;
    writeContent(items);
    return existing;
}

function deleteContent(id) {
    const items = readContent();
    const index = items.findIndex(item => item.id === id);
    if (index === -1) throw new Error("Content item not found.");

    const [removed] = items.splice(index, 1);
    writeContent(items);
    return removed;
}

module.exports = {
    getAllContent,
    getContentById,
    createContent,
    updateContent,
    deleteContent
};