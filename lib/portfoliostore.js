const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const PROJECTS_FILE = path.join(DATA_DIR, "portfolioProjects.json");

// Must match the filter buttons in portfolio.html exactly
const VALID_CATEGORIES = ["branding", "logos", "posters", "social", "web"];

function ensureFile() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(PROJECTS_FILE)) {
        fs.writeFileSync(PROJECTS_FILE, "[]", "utf8");
    }
}

function readProjects() {
    ensureFile();
    const raw = fs.readFileSync(PROJECTS_FILE, "utf8");
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error("portfolioProjects.json is corrupted, resetting to empty list:", err);
        return [];
    }
}

function writeProjects(projects) {
    ensureFile();
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), "utf8");
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
function getAllProjects() {
    return readProjects()
        .map(normalizeProject)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
}

function getProjectById(id) {
    const found = readProjects().find(p => p.id === id);
    return found ? normalizeProject(found) : null;
}

function createProject({ title, category, image, link_title, show_on_portfolio }) {
    title = typeof title === "string" ? title.trim() : "";
    category = typeof category === "string" ? category.trim() : "";
    image = typeof image === "string" ? image.trim() : "";
    link_title = typeof link_title === "string" ? link_title.trim() : title;

    if (!title) throw new Error("Title is required.");
    if (!VALID_CATEGORIES.includes(category)) {
        throw new Error(`Category must be one of: ${VALID_CATEGORIES.join(", ")}.`);
    }
    if (!image) throw new Error("An image is required.");

    const projects = readProjects();
    const maxOrder = projects.reduce((max, p) => Math.max(max, p.order || 0), 0);

    const newProject = {
        id: crypto.randomBytes(8).toString("hex"),
        title,
        category,
        image,
        link_title: link_title || title,
        // Defaults to true (shown on Portfolio) unless explicitly set to
        // false from the admin form's toggle.
        show_on_portfolio: show_on_portfolio === false ? false : true,
        order: maxOrder + 1,
        created_at: new Date().toISOString()
    };

    projects.push(newProject);
    writeProjects(projects);
    return newProject;
}

function updateProject(id, { title, category, image, link_title, order, show_on_portfolio }) {
    const projects = readProjects();
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
    writeProjects(projects);
    return existing;
}

function deleteProject(id) {
    const projects = readProjects();
    const index = projects.findIndex(p => p.id === id);
    if (index === -1) throw new Error("Project not found.");

    const [removed] = projects.splice(index, 1);
    writeProjects(projects);
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
