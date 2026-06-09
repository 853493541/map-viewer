const fs = require("fs");
const path = require("path");

const targets = ["CameraShake", "Camera Shake", "Shake", "PARSYS_ReadParticleCameraShakeBlock"];
// Expanding search to common bins and jx3 locations
const searchPaths = [
    "C:\\SeasunGame\\Game\\JX3\\bin\\zhcn_hd\\MovieEditor",
    "C:\\SeasunGame\\Game\\JX3\\bin\\zhcn_hd\\bin64"
];

function searchInFile(filePath) {
    try {
        const buffer = fs.readFileSync(filePath);
        targets.forEach(target => {
            const targetBufAscii = Buffer.from(target, "ascii");
            if (buffer.indexOf(targetBufAscii) !== -1) {
                console.log("Found \"" + target + "\" (ASCII) in: " + filePath);
            }
            const targetBufUtf16 = Buffer.from(target, "utf16le");
            if (buffer.indexOf(targetBufUtf16) !== -1) {
                console.log("Found \"" + target + "\" (UTF16LE) in: " + filePath);
            }
        });
    } catch (err) {}
}

function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    files.forEach(file => {
        const fullPath = path.join(dir, file);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                walk(fullPath);
            } else {
                const ext = path.extname(fullPath).toLowerCase();
                if ([".exe", ".dll", ".bin", ".dat", ".so"].includes(ext)) {
                    searchInFile(fullPath);
                }
            }
        } catch (e) {}
    });
}
searchPaths.forEach(walk);
