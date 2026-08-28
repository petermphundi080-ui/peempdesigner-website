const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const PAGE_CONTENT_FILE = path.join(DATA_DIR, "pageContent.json");

function ensureFile() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(PAGE_CONTENT_FILE)) {
        fs.writeFileSync(PAGE_CONTENT_FILE, "{}", "utf8");
    }
}

function readAll() {
    ensureFile();
    const raw = fs.readFileSync(PAGE_CONTENT_FILE, "utf8");
    try {
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
    } catch (err) {
        console.error("pageContent.json is corrupted, resetting to empty object:", err);
        return {};
    }
}

function writeAll(data) {
    ensureFile();
    fs.writeFileSync(PAGE_CONTENT_FILE, JSON.stringify(data, null, 2), "utf8");
}

// List of pages and their allowed text field keys.
// This is the source of truth for what CAN be edited -- prevents arbitrary
// keys being injected into the data file from a malformed request.
const PAGE_SCHEMAS = {
    about: [
        "hero_heading", "hero_paragraph",
        "story_heading", "story_paragraph",
        "strengths_heading",
        "strength1_heading", "strength1_paragraph",
        "strength2_heading", "strength2_paragraph",
        "strength3_heading", "strength3_paragraph",
        "cta_text", "footer_text"
    ],
    contact: [
        "hero_tag", "hero_heading", "hero_paragraph",
        "info_heading", "form_heading",
        "submit_button_text",
        "footer_text1", "footer_text2"
    ],
    home: [
        "hero_line1", "hero_line2", "hero_span",
        "hero_intro", "portfolio_button_text", "hire_button_text",
        "services_title",
        "service1_title", "service1_desc",
        "service2_title", "service2_desc",
        "service3_title", "service3_desc",
        "service4_title", "service4_desc",
        "footer_text"
    ],
    portfolio: [
        "hero_tag", "hero_heading", "hero_paragraph",
        "featured_tag", "featured_heading", "featured_paragraph", "featured_button_text",
        "cta_heading", "cta_paragraph", "cta_button_text",
        "footer_text1", "footer_text2"
    ]
};

// Separate list of image field keys per page. These are stored as plain
// URL strings in the same content object as text fields, but the admin UI
// needs to know which keys are images (to show an uploader) vs text
// (to show a text box).
const PAGE_IMAGE_SCHEMAS = {
    about: ["story_image", "hero_bg_image"],
    contact: [],
    home: ["hero_image", "logo_image"],
    portfolio: ["featured_image"]
};

function getPageContent(pageName) {
    if (!PAGE_SCHEMAS[pageName]) {
        throw new Error("Unknown page.");
    }
    const all = readAll();
    return all[pageName] || {};
}

function getPageSchema(pageName) {
    if (!PAGE_SCHEMAS[pageName]) return null;
    return {
        text: PAGE_SCHEMAS[pageName],
        images: PAGE_IMAGE_SCHEMAS[pageName] || []
    };
}

function updatePageContent(pageName, fields) {
    if (!PAGE_SCHEMAS[pageName]) {
        throw new Error("Unknown page.");
    }
    if (!fields || typeof fields !== "object") {
        throw new Error("Invalid content payload.");
    }

    const allowedKeys = [
        ...PAGE_SCHEMAS[pageName],
        ...(PAGE_IMAGE_SCHEMAS[pageName] || [])
    ];
    const all = readAll();
    const existing = all[pageName] || {};

    for (const key of Object.keys(fields)) {
        if (!allowedKeys.includes(key)) {
            continue; // silently ignore unknown keys rather than erroring the whole save
        }
        const value = typeof fields[key] === "string" ? fields[key].trim() : "";
        existing[key] = value;
    }

    all[pageName] = existing;
    writeAll(all);
    return existing;
}

module.exports = {
    getPageContent,
    getPageSchema,
    updatePageContent,
    PAGE_SCHEMAS,
    PAGE_IMAGE_SCHEMAS
};
