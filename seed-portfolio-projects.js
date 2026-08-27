// Run this once with: node seed-portfolio-projects.js
// It adds your 6 existing portfolio projects into the new project manager
// so nothing is lost when the page switches from hardcoded to dynamic.
// Safe to run only once -- if projects already exist, it will NOT add
// duplicates; it stops and tells you.

const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "data");
const dataFile = path.join(dataDir, "portfolioProjects.json");

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

let existing = [];
if (fs.existsSync(dataFile)) {
    try {
        existing = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    } catch (err) {
        existing = [];
    }
}

if (Array.isArray(existing) && existing.length > 0) {
    console.log(`portfolioProjects.json already has ${existing.length} project(s) -- nothing was added, to avoid duplicates.`);
    process.exit(0);
}

const crypto = require("crypto");
const now = new Date().toISOString();

function makeProject(order, title, category, image, link_title) {
    return {
        id: crypto.randomBytes(8).toString("hex"),
        title,
        category,
        image,
        link_title: link_title || title,
        order,
        created_at: now
    };
}

const seedProjects = [
    makeProject(1, "Mavunex", "branding", "images/64659a13-022c-44e1-a26b-6ec3b8d76d8f.png", "Mavunex"),
    makeProject(2, "Shawarma Campaign", "branding", "images/Shawarma.png", "Shawarma Campaign"),
    makeProject(3, "Elie's Logo Mark", "logos", "images/b1837849-135a-42ae-b80f-9dc40f868238.png", "Elie's Logo Mark"),
    makeProject(4, "Sports Shoes Campaign", "posters", "images/sports shoes.png", "Sports Shoes Campaign"),
    makeProject(5, "Elie's Visual Identity", "branding", "images/Elie`s.png", "Elie's Visual Identity"),
    makeProject(6, "Sports Shoes Social Campaign", "social", "images/sports shoes.png", "Sports Shoes Social Campaign")
];

fs.writeFileSync(dataFile, JSON.stringify(seedProjects, null, 2), "utf8");
console.log(`Done! Added ${seedProjects.length} existing projects to the portfolio manager.`);
console.log("You can now edit, remove, or add to them from the admin panel.");
