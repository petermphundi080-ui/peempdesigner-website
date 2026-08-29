const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const remoteStore = require("./remotejsonstore");

const DATA_DIR = path.join(__dirname, "..", "data");
const PROJECTS_FILE = path.join(DATA_DIR, "portfolioProjects.json");

// Where the project list lives on Cloudinary once configured. This is the
// source of truth in production -- the local file below is only used as a
// fallback when no Cloudinary credentials are set (e.g. local development).
const REMOTE_KEY = "peempdesigner/data/portfolioProjects.json";

// Must match the filter buttons in portfolio.html exactly
const VALID_CATEGORIES = ["branding", "logos", "posters", "social", "web"];

// In-memory cache so a normal page view doesn't have to round-trip to
// Cloudinary every single time. Any write refreshes the cache immediately,
// and it's re-fetched from Cloudinary if it's older than CACHE_TTL_MS (so a
// fresh server instance, e.g. right after a redeploy, still picks up the
// latest saved data instead of starting from an empty list).
let cache = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 30 * 1000;

function ensureLocalFile() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(PROJECTS_FILE)) {
        fs.writeFileSync(PROJECTS_FILE, "[]", "utf8");
    }
}

function readLocalFile() {
    ensureLocalFile();
    const raw = fs.readFileSync(PROJECTS_FILE, "utf8");
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error("portfolioProjects.json is corrupted, resetting to empty list:", err);
        return [];
    }
}

function writeLocalFile(projects) {
    ensureLocalFile();
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), "utf8");
}

async function readProjects({ forceRefresh = false } = {}) {
    const cacheIsFresh =
        cache !== null && Date.now() - cacheLoadedAt < CACHE_TTL_MS;

    if (!forceRefresh && cacheIsFresh) {
        return cache;
    }

    if (!remoteStore.isConfigured()) {
        // No Cloudinary credentials set -- fall back to the old local-file
        // behavior so local development without those env vars still works.
        const local = readLocalFile();
        cache = local;
        cacheLoadedAt = Date.now();
        return local;
    }

    const remote = await remoteStore.downloadJson(REMOTE_KEY);
    const projects = Array.isArray(remote) ? remote : [];

    cache = projects;
    cacheLoadedAt = Date.now();
    return projects;
}

async function writeProjects(projects) {
    cache = projects;
    cacheLoadedAt = Date.now();

    if (!remoteStore.isConfigured()) {
        writeLocalFile(projects);
        return;
    }

    await remoteStore.uploadJson(REMOTE_KEY, projects);
}

// Older projects saved before the show_on_portfolio field existed don't
// have it set in the data file. Treat anything other than an explicit
// `false` as visible on the Portfolio page, so existing projects keep
// showing exactly as before.
function normalizeProject(project) {
    return {
        ...project,
        show_on_portfolio: project.show_on_portfolio !== false
    };
}

// Projects are returned in a stable display order (an explicit "order"
// number), so admins can reorder them without relying on creation date.
async function getAllProjects() {
    const projects = await readProjects();
    return projects
        .map(normalizeProject)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
}

async function getProjectById(id) {
    const projects = await readProjects();
    const found = projects.find(p => p.id === id);
    return found ? normalizeProject(found) : null;
}

async function createProject({ title, category, image, link_title, show_on_portfolio }) {
    title = typeof title === "string" ? title.trim() : "";
    category = typeof category === "string" ? category.trim() : "";
    image = typeof image === "string" ? image.trim() : "";
    link_title = typeof link_title === "string" ? link_title.trim() : title;

    if (!title) throw new Error("Title is required.");
    if (!VALID_CATEGORIES.includes(category)) {
        throw new Error(`Category must be one of: ${VALID_CATEGORIES.join(", ")}.`);
    }
    if (!image) throw new Error("An image is required.");

    // Force a fresh read here (rather than relying on a possibly-stale
    // cache) so the max-order calculation and the record we write back
    // both reflect the latest saved state.
    const projects = await readProjects({ forceRefresh: true });
    const maxOrder = projects.reduce((max, p) => Math.max(max, p.order || 0), 0);

    const newProject = {
        id: crypto.randomBytes(8).toString("hex"),
        title,
        category,
        image,
        link_title: link_title || title,
        show_on_portfolio: show_on_portfolio === false ? false : true,
        order: maxOrder + 1,
        created_at: new Date().toISOString()
    };

    projects.push(newProject);
    await writeProjects(projects);
    return newProject;
}

async function updateProject(id, { title, category, image, link_title, order, show_on_portfolio }) {
    const projects = await readProjects({ forceRefresh: true });
    const index = projects.findIndex(p => p.id === id);
    if (index === -1) throw new Error("Project not found.");

    const existing = projects[index];

    if (title !== undefined) {
        title = typeof title === "string" ? title.trim() : "";
        if (!title) throw new Error("Title cannot be empty.");
        existing.title = title;
    }

    if (category !== undefined) {
        category = typeof category === "string" ? category.trim() : "";
        if (!VALID_CATEGORIES.includes(category)) {
            throw new Error(`Category must be one of: ${VALID_CATEGORIES.join(", ")}.`);
        }
        existing.category = category;
    }

    if (image !== undefined) {
        image = typeof image === "string" ? image.trim() : "";
        if (!image) throw new Error("Image cannot be empty.");
        existing.image = image;
    }

    if (link_title !== undefined) {
        existing.link_title = typeof link_title === "string" ? link_title.trim() : existing.title;
    }

    if (order !== undefined && typeof order === "number") {
        existing.order = order;
    }

    if (show_on_portfolio !== undefined) {
        existing.show_on_portfolio = show_on_portfolio === false ? false : true;
    }

    existing.updated_at = new Date().toISOString();

    projects[index] = existing;
    await writeProjects(projects);
    return existing;
}

async function deleteProject(id) {
    const projects = await readProjects({ forceRefresh: true });
    const index = projects.findIndex(p => p.id === id);
    if (index === -1) throw new Error("Project not found.");

    const [removed] = projects.splice(index, 1);
    await writeProjects(projects);
    return removed;
}

module.exports = {
    getAllProjects,
    getProjectById,
    createProject,
    updateProject,
    deleteProject,
    VALID_CATEGORIES
};
