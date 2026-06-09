const fs = require("fs");
const path = require("path");

const targets = ["CameraShake", "Camera Shake", "Shake", "PARSYS_ReadParticleCameraShakeBlock"];
const searchPath = "C:\\SeasunGame\\Game\\JX3\\bin\\zhcn_hd\\MovieEditor";

function searchInFile(filePath) {
    try {
        const buffer = fs.readFileSync(filePath);
        // Direct buffer search to avoid encoding issues or large string overhead
        targets.forEach(target => {
            const targetBuf = Buffer.from(target, "ascii");
            if (buffer.indexOf(targetBuf) !== -1) {
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
        if (fs.statSync(fullPath).isDirectory()) {
            walk(fullPath);
        } else {
            const ext = path.extname(fullPath).toLowerCase();
            if ([".exe", ".dll", ".bin", ".dat", ".so"].includes(ext)) {
                searchInFile(fullPath);
            }
        }
    });
}
walk(searchPath);
