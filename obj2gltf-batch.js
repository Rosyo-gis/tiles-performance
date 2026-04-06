const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

const OBJ_DIR = './obj';

async function main() {
    // lod1・lod2 の全サブフォルダを収集する（重複排除なし、全て変換対象）
    const subEntries = [];
    for (const lod of (await fs.readdir(OBJ_DIR)).sort()) {
        const lodPath = path.join(OBJ_DIR, lod);
        if (!(await fs.stat(lodPath)).isDirectory()) continue;
        for (const sub of await fs.readdir(lodPath)) {
            const subPath = path.join(lodPath, sub);
            if ((await fs.stat(subPath)).isDirectory()) subEntries.push(subPath);
        }
    }

    for (const entryPath of subEntries) {
        const entry = path.relative(OBJ_DIR, entryPath);
        const files = await fs.readdir(entryPath);
        const objFile = files.find(f => f.endsWith('.obj'));
        if (!objFile) {
            console.warn(`⚠️  ${entry}: no .obj found, skip`);
            continue;
        }

        const inputPath = path.join(entryPath, objFile);
        const outputPath = path.join(entryPath, objFile.replace('.obj', '.gltf'));

        if (await fs.pathExists(outputPath)) {
            console.log(`✓  ${objFile} already converted, skip`);
            continue;
        }

        try {
            execSync(`obj2gltf -i "${inputPath}"`, { stdio: 'inherit' });
            console.log(`✅ ${objFile} → ${path.basename(outputPath)}`);
        } catch (e) {
            console.error(`❌ ${objFile} failed: ${e.message}`);
        }
    }
}

main().catch(console.error);
