const { NodeIO, Document, Logger } = require('@gltf-transform/core');
const { KHRTextureBasisu } = require('@gltf-transform/extensions');
const { prune, dedup, cloneDocument, weld, simplify } = require('@gltf-transform/functions');
const { MeshoptSimplifier } = require('meshoptimizer');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { Cartesian3, Transforms, Matrix4 } = require('cesium');

const OBJ_DIR = './obj';
const OUTPUT_DIR = './dist';
const TILES_DIR = path.join(OUTPUT_DIR, 'tiles');
// この面数以下のノードはそのままリーフタイルとして出力する
const FACE_THRESHOLD = 5000;
// メッシュ簡略化後に残す面数の割合（fine LOD のみ適用）
const SIMPLIFY_RATIO = 0.3;
// lod1→lod2 の切り替え geometricError（ピクセル単位のスクリーン誤差）
const LOD_SWITCH_ERROR = 20;

// obj/ 配下の LOD ディレクトリを走査し、各サブフォルダに lodLevel を付けて返す
// アルファベット順ソートで最後のディレクトリを fine（高精度）、それ以前を coarse（低精度）とする
async function scanLodDirs(objDir) {
    const lodDirs = [];
    for (const d of (await fs.readdir(objDir)).sort()) {
        const p = path.join(objDir, d);
        if ((await fs.stat(p)).isDirectory()) lodDirs.push(p);
    }
    if (lodDirs.length === 0) return [];

    // 各 LOD ディレクトリのサブフォルダを buildingId → subPath マップで収集する
    const lodMaps = await Promise.all(lodDirs.map(async lodPath => {
        const map = new Map();
        for (const sub of await fs.readdir(lodPath)) {
            const subPath = path.join(lodPath, sub);
            if ((await fs.stat(subPath)).isDirectory()) map.set(sub, subPath);
        }
        return map;
    }));

    const fineLodMap = lodMaps[lodMaps.length - 1];         // 最後 = fine（lod2）
    const coarseLodMap = lodMaps.length > 1 ? lodMaps[0] : null; // 最初 = coarse（lod1）
    const fineBuildingIds = new Set(fineLodMap.keys());

    const subEntries = [];
    for (const [buildingId, subPath] of fineLodMap) {
        subEntries.push({ subPath, buildingId, lodLevel: 'fine' });
    }
    if (coarseLodMap) {
        for (const [buildingId, subPath] of coarseLodMap) {
            // fine と同名ならペア（遠距離用 coarse）、なければ単独リーフ
            const lodLevel = fineBuildingIds.has(buildingId) ? 'coarse-paired' : 'coarse-only';
            subEntries.push({ subPath, buildingId, lodLevel });
        }
    }
    return subEntries;
}

// subEntries を元に全 .gltf を一つの Document にマージする
// 各プリミティブに { tempID, buildingId, lodLevel } をタグ付けし、primEntries として返す
async function loadAndMergeGltfs(subEntries, io) {
    const mergedDoc = new Document();
    const mergedBuf = mergedDoc.createBuffer();
    const scene = mergedDoc.createScene('scene');
    const rootNode = mergedDoc.createNode('root');
    scene.addChild(rootNode);
    mergedDoc.getRoot().setDefaultScene(scene);

    const primEntries = [];

    for (const { subPath, buildingId, lodLevel } of subEntries) {
        const files = await fs.readdir(subPath);
        const gltfFile = files.find(f => f.endsWith('.gltf'));
        if (!gltfFile) {
            console.warn(`⚠️  ${path.relative(OBJ_DIR, subPath)} [${lodLevel}]: no .gltf, skip`);
            continue;
        }

        const doc = await io.read(path.join(subPath, gltfFile));
        console.log(`📂 [${lodLevel}] ${gltfFile}`);

        // ソースファイルごとにテクスチャ・マテリアルのコピーキャッシュを管理し、重複を防ぐ
        const texCache = new Map();
        const matCache = new Map();

        const copyTex = (srcTex) => {
            if (!srcTex) return null;
            if (texCache.has(srcTex)) return texCache.get(srcTex);
            const t = mergedDoc.createTexture(srcTex.getName());
            t.setImage(srcTex.getImage());
            t.setMimeType(srcTex.getMimeType());
            texCache.set(srcTex, t);
            return t;
        };

        // テクスチャのサンプラー設定（UV座標・ラップモード・フィルタ）をコピーする
        const copyTexInfo = (srcInfo, dstInfo) => {
            if (!srcInfo || !dstInfo) return;
            dstInfo.setTexCoord(srcInfo.getTexCoord());
            dstInfo.setWrapS(srcInfo.getWrapS());
            dstInfo.setWrapT(srcInfo.getWrapT());
            dstInfo.setMinFilter(srcInfo.getMinFilter());
            dstInfo.setMagFilter(srcInfo.getMagFilter());
        };

        // PBRマテリアルと紐づくテクスチャを全スロット分マージ先にコピーする
        const copyMat = (srcMat) => {
            if (!srcMat) return null;
            if (matCache.has(srcMat)) return matCache.get(srcMat);
            const m = mergedDoc.createMaterial(srcMat.getName());
            m.setBaseColorFactor(srcMat.getBaseColorFactor());
            m.setAlphaMode(srcMat.getAlphaMode());
            m.setAlphaCutoff(srcMat.getAlphaCutoff());
            m.setDoubleSided(srcMat.getDoubleSided());
            m.setMetallicFactor(srcMat.getMetallicFactor());
            m.setRoughnessFactor(srcMat.getRoughnessFactor());
            m.setEmissiveFactor(srcMat.getEmissiveFactor());
            const t0 = copyTex(srcMat.getBaseColorTexture());
            if (t0) { m.setBaseColorTexture(t0); copyTexInfo(srcMat.getBaseColorTextureInfo(), m.getBaseColorTextureInfo()); }
            const t1 = copyTex(srcMat.getMetallicRoughnessTexture());
            if (t1) { m.setMetallicRoughnessTexture(t1); copyTexInfo(srcMat.getMetallicRoughnessTextureInfo(), m.getMetallicRoughnessTextureInfo()); }
            const t2 = copyTex(srcMat.getNormalTexture());
            if (t2) { m.setNormalTexture(t2); m.setNormalScale(srcMat.getNormalScale()); copyTexInfo(srcMat.getNormalTextureInfo(), m.getNormalTextureInfo()); }
            const t3 = copyTex(srcMat.getOcclusionTexture());
            if (t3) { m.setOcclusionTexture(t3); m.setOcclusionStrength(srcMat.getOcclusionStrength()); copyTexInfo(srcMat.getOcclusionTextureInfo(), m.getOcclusionTextureInfo()); }
            const t4 = copyTex(srcMat.getEmissiveTexture());
            if (t4) { m.setEmissiveTexture(t4); copyTexInfo(srcMat.getEmissiveTextureInfo(), m.getEmissiveTextureInfo()); }
            matCache.set(srcMat, m);
            return m;
        };

        // 各プリミティブをマージ先 Document にコピーし、識別情報をタグ付けする
        doc.getRoot().listMeshes().forEach(srcMesh => {
            srcMesh.listPrimitives().forEach(srcPrim => {
                const newPrim = mergedDoc.createPrimitive();

                for (const semantic of srcPrim.listSemantics()) {
                    const srcAcc = srcPrim.getAttribute(semantic);
                    const newAcc = mergedDoc.createAccessor()
                        .setType(srcAcc.getType())
                        .setArray(srcAcc.getArray().slice())
                        .setBuffer(mergedBuf);
                    newPrim.setAttribute(semantic, newAcc);
                }

                const srcIdx = srcPrim.getIndices();
                if (srcIdx) {
                    const newIdx = mergedDoc.createAccessor()
                        .setType('SCALAR')
                        .setArray(srcIdx.getArray().slice())
                        .setBuffer(mergedBuf);
                    newPrim.setIndices(newIdx);
                }

                const mat = copyMat(srcPrim.getMaterial());
                if (mat) newPrim.setMaterial(mat);

                // タイル書き出し時に対象プリムを特定するための識別情報を付与する
                const tempID = Math.random().toString(36).slice(2);
                newPrim.setExtras({ tempID, buildingId, lodLevel });

                const pos = newPrim.getAttribute('POSITION');
                const pMin = pos.getMin([0, 0, 0]);
                const pMax = pos.getMax([0, 0, 0]);
                const count = newPrim.getIndices() ? newPrim.getIndices().getCount() : pos.getCount();

                primEntries.push({
                    prim: newPrim,
                    center: [(pMin[0]+pMax[0])/2, (pMin[1]+pMax[1])/2, (pMin[2]+pMax[2])/2],
                    faces: Math.round(count / 3),
                    fullMin: pMin,
                    fullMax: pMax,
                    buildingId,
                    lodLevel,
                    tempID,
                });

                const newMesh = mergedDoc.createMesh();
                newMesh.addPrimitive(newPrim);
                rootNode.addChild(mergedDoc.createNode().setMesh(newMesh));
            });
        });
    }

    return { doc: mergedDoc, primEntries };
}

// ドキュメント内の全テクスチャを toktx バイナリで KTX2（ETC1S）に圧縮する
async function compressToKtx2(doc) {
    const basisuExt = doc.createExtension(KHRTextureBasisu).setRequired(true);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toktx-'));
    try {
        await Promise.all(doc.getRoot().listTextures().map(async (texture, i) => {
            const mimeType = texture.getMimeType();
            if (mimeType === 'image/ktx2') return; // 既にKTX2圧縮済みならスキップ
            const ext = mimeType === 'image/png' ? '.png' : '.jpg';
            const srcPath = path.join(tmpDir, `tex${i}${ext}`);
            const dstPath = path.join(tmpDir, `tex${i}.ktx2`);
            await fs.writeFile(srcPath, texture.getImage());
            await execFileAsync('toktx', [
                '--t2',              // KTX2形式で出力
                '--encode', 'etc1s', // ETC1S（高圧縮・GPU転送サイズ削減）
                '--clevel', '1',     // 圧縮速度レベル（1=最速）
                '--qlevel', '128',   // 品質レベル（0–255）
                dstPath, srcPath
            ]);
            texture.setImage(await fs.readFile(dstPath)).setMimeType('image/ktx2');
        }));
    } finally {
        await fs.remove(tmpDir);
    }
}

// 指定した tempID セットに含まれるプリミティブだけを残した GLB ファイルを書き出す
// doSimplify=true のとき weld→simplify を適用する（fine LOD 用）
async function writeGlbTile(fileName, keepIDs, sourceDoc, io, originX, originY, originZ, doSimplify) {
    const newDoc = cloneDocument(sourceDoc);

    newDoc.getRoot().listMeshes().forEach(mesh => {
        mesh.listPrimitives().forEach(prim => {
            if (!keepIDs.has(prim.getExtras().tempID)) { prim.dispose(); return; }

            // 頂点座標を原点オフセット分だけ平行移動する
            const position = prim.getAttribute('POSITION');
            for (let i = 0; i < position.getCount(); i++) {
                const v = position.getElement(i, []);
                position.setElement(i, [v[0] - originX, v[1] - originY, v[2] - originZ]);
            }
        });
        if (mesh.listPrimitives().length === 0) mesh.dispose();
    });

    // ログは SILENT にして prune/dedup の詳細出力を抑制する
    newDoc.setLogger(new Logger(Logger.Verbosity.SILENT));
    await MeshoptSimplifier.ready;

    const transforms = [weld()];
    if (doSimplify) {
        // fine LOD のみ面数を削減する（coarse は既に粗いモデルのためスキップ）
        transforms.push(simplify({ simplifier: MeshoptSimplifier, ratio: SIMPLIFY_RATIO, error: 0.01 }));
    }
    transforms.push(prune(), dedup());
    await newDoc.transform(...transforms);

    // テクスチャを KTX2（ETC1S）に圧縮してから GLB として書き出す
    await compressToKtx2(newDoc);
    await io.write(path.join(TILES_DIR, fileName), newDoc);
}

async function main() {
    await fs.emptyDir(OUTPUT_DIR);
    await fs.ensureDir(TILES_DIR);

    // KHRTextureBasisu 拡張を有効化して KTX2 テクスチャの読み書きに対応する
    const io = new NodeIO().registerExtensions([KHRTextureBasisu]);

    // LOD ディレクトリを走査してサブエントリを収集し、全 gltf をマージする
    const subEntries = await scanLodDirs(OBJ_DIR);
    const { doc: document, primEntries } = await loadAndMergeGltfs(subEntries, io);

    // 四分木分割の対象: fine（lod2）+ coarse-only（lod1のみ）
    // coarse-paired は四分木に含めず、ラッパータイル生成時に別途参照する
    const allPrims = primEntries.filter(p => p.lodLevel !== 'coarse-paired');

    // coarse-paired を buildingId → primEntry[] マップで管理する
    const coarsePairedByBuilding = new Map();
    for (const p of primEntries.filter(p => p.lodLevel === 'coarse-paired')) {
        if (!coarsePairedByBuilding.has(p.buildingId)) coarsePairedByBuilding.set(p.buildingId, []);
        coarsePairedByBuilding.get(p.buildingId).push(p);
    }

    // データセット全体の包囲ボックスを求める
    let gMin = [Infinity, Infinity, Infinity], gMax = [-Infinity, -Infinity, -Infinity];
    for (const p of allPrims) {
        for (let i = 0; i < 3; i++) {
            gMin[i] = Math.min(gMin[i], p.fullMin[i]);
            gMax[i] = Math.max(gMax[i], p.fullMax[i]);
        }
    }

    // 座標系の原点オフセット（データセットに合わせて調整する）
    const originX = -5766.66, originY = -41419.02, originZ = 3.41;
    console.log(`📐 ORIGIN: X=${originX.toFixed(2)}, Y=${originY.toFixed(2)}, Z=${originZ.toFixed(2)}`);

    const globalCenterX = (gMin[0] + gMax[0]) / 2;
    const globalCenterY = (gMin[1] + gMax[1]) / 2;
    const globalCenterZ = (gMin[2] + gMax[2]) / 2;

    // Cesium 上での配置先（地理座標）を手動で指定する
    const targetLon = 139.769666207;
    const targetLat = 35.6266511706;

    // ENU（東北上）座標系から ECEF への変換行列を生成し、tileset.json の transform に設定する
    const destination = Cartesian3.fromDegrees(targetLon, targetLat, 35);
    const enuMatrix = Transforms.eastNorthUpToFixedFrame(destination);
    const matrixArray = Matrix4.pack(enuMatrix, new Array(16));

    // 四分木でプリミティブを空間分割する
    const tree = splitNode(allPrims, [gMin[0], gMin[1]], [gMax[0], gMax[1]], 0);

    // 進捗表示用にリーフタイルの総数を先に数える
    function countLeaves(node) {
        return node.children.length === 0 && node.prims && node.prims.length > 0
            ? 1 : (node.children || []).reduce((s, c) => s + countLeaves(c), 0);
    }
    const totalTiles = countLeaves(tree);
    const progress = { done: 0, total: totalTiles };

    const tileset = {
        asset: { version: '1.0', gltfUpAxis: 'Z' },
        geometricError: 1000,
        root: {
            transform: matrixArray,
            ...(await exportNodes(tree, io, document, {
                globalCenterX, globalCenterY, globalCenterZ,
                gZMin: gMin[2], gZMax: gMax[2],
                originX, originY, originZ,
                progress,
                coarsePairedByBuilding,
            }))
        }
    };

    await fs.outputJson(path.join(OUTPUT_DIR, 'tileset.json'), tileset, { spaces: 2 });
    console.log(`✅ tileset.json written`);
}

// プリミティブ群を四分木で再帰的に空間分割する
// 分割判定は fine の面数のみで行う。coarse-only は early-stop して浅いレベルでリーフになる
function splitNode(prims, min, max, level) {
    const totalFaces = prims.reduce((sum, p) => p.lodLevel === 'fine' ? sum + p.faces : sum, 0);
    if (totalFaces <= FACE_THRESHOLD || prims.length === 0 || level > 8) {
        return { level, totalFaces, prims, children: [], min, max };
    }
    const midX = (min[0] + max[0]) / 2;
    const midY = (min[1] + max[1]) / 2;
    // XY 平面を4象限に分割し、各プリミティブの重心で振り分ける
    const buckets = [
        { min: [midX, midY], max: [max[0], max[1]], prims: [] },
        { min: [min[0], midY], max: [midX, max[1]], prims: [] },
        { min: [min[0], min[1]], max: [midX, midY], prims: [] },
        { min: [midX, min[1]], max: [max[0], midY], prims: [] }
    ];
    prims.forEach(p => {
        const [x, y] = p.center;
        const idx = (x > midX) ? (y > midY ? 0 : 3) : (y > midY ? 1 : 2);
        buckets[idx].prims.push(p);
    });
    return { level, totalFaces, min, max, children: buckets.map(b => splitNode(b.prims, b.min, b.max, level + 1)) };
}

// 分割木ノードを再帰的に処理し、tileset.json 用のタイルオブジェクトを返す
//
// リーフノードの LOD 構成:
//   [A] fine あり → coarse ラッパー（lod1 GLB）→ fine リーフ（lod2 GLB + coarse-only）
//   [B] coarse-only のみ → そのままリーフ（LOD 切り替えなし）
async function exportNodes(node, io, sourceDoc, globalParams) {
    const { min, max, level, prims = [], children = [] } = node;
    const { gZMin, gZMax, originX, originY, originZ, progress, coarsePairedByBuilding } = globalParams;

    // このノードの XY 中心・半径を原点オフセット後の座標で計算する
    const cx = (min[0] + max[0]) / 2 - originX;
    const cy = (min[1] + max[1]) / 2 - originY;
    const hx = (max[0] - min[0]) / 2;
    const hy = (max[1] - min[1]) / 2;

    // Z 範囲はリーフなら収録プリミティブから、中間ノードはデータセット全体から取得する
    let zMin, zMax;
    if (prims.length > 0) {
        zMin = prims.reduce((m, p) => Math.min(m, p.fullMin[2]), Infinity);
        zMax = prims.reduce((m, p) => Math.max(m, p.fullMax[2]), -Infinity);
    } else {
        zMin = gZMin;
        zMax = gZMax;
    }
    const cz = (zMin + zMax) / 2 - originZ;
    const hz = (zMax - zMin) / 2;

    const boundingVolume = { box: [cx, cy, cz,  hx, 0, 0,  0, hy, 0,  0, 0, hz] };
    const tile = {
        boundingVolume,
        geometricError: 500 / Math.pow(2, level),
        refine: 'REPLACE'
    };

    if (children.length === 0 && prims.length > 0) {
        const baseName = `tile_${level}_${Math.floor((min[0]+max[0])/2)}_${Math.floor((min[1]+max[1])/2)}`;

        // プリミティブを LOD レベルで分類する
        const finePrims     = prims.filter(p => p.lodLevel === 'fine');
        const coarseOnlyPrims = prims.filter(p => p.lodLevel === 'coarse-only');

        if (finePrims.length > 0) {
            // [A] fine LOD の建物がある → 2段 LOD 構成
            const fineFileName   = `${baseName}.glb`;
            const coarseFileName = `${baseName}_coarse.glb`;

            // fine リーフ: fine 建物 + coarse-only 建物（REPLACE 後に全建物が表示されるようにする）
            const fineKeepIDs = new Set([
                ...finePrims.map(p => p.tempID),
                ...coarseOnlyPrims.map(p => p.tempID),
            ]);
            await writeGlbTile(fineFileName, fineKeepIDs, sourceDoc, io, originX, originY, originZ, true);

            // coarse ラッパー: fine 建物の対応 coarse-paired + coarse-only（遠距離での粗い表示）
            const pairedBuildingIds = new Set(finePrims.map(p => p.buildingId));
            const coarsePairedPrims = [...pairedBuildingIds]
                .flatMap(id => coarsePairedByBuilding.get(id) || []);
            const coarseKeepIDs = new Set([
                ...coarsePairedPrims.map(p => p.tempID),
                ...coarseOnlyPrims.map(p => p.tempID),
            ]);

            if (coarseKeepIDs.size > 0) {
                // coarse は既に粗いモデルのため simplify しない
                await writeGlbTile(coarseFileName, coarseKeepIDs, sourceDoc, io, originX, originY, originZ, false);
                tile.content = { uri: `tiles/${coarseFileName}` };
                tile.geometricError = LOD_SWITCH_ERROR;
                tile.children = [{
                    boundingVolume,
                    geometricError: 0,
                    refine: 'REPLACE',
                    content: { uri: `tiles/${fineFileName}` },
                }];
            } else {
                // 対応 coarse が存在しない場合は fine をそのままリーフとして使う
                tile.content = { uri: `tiles/${fineFileName}` };
                tile.geometricError = 0;
            }
        } else {
            // [B] coarse-only のみ → LOD 切り替えなし、単一リーフとして出力
            const fileName = `${baseName}.glb`;
            const keepIDs = new Set(coarseOnlyPrims.map(p => p.tempID));
            await writeGlbTile(fileName, keepIDs, sourceDoc, io, originX, originY, originZ, false);
            tile.content = { uri: `tiles/${fileName}` };
            tile.geometricError = 0;
        }

        progress.done++;
        process.stdout.write(`\r  tiles: ${progress.done}/${progress.total}`);
        if (progress.done === progress.total) process.stdout.write('\n');
        return tile;
    }

    if (children.length > 0) {
        const validChildren = [];
        for (const child of children) {
            // totalFaces は fine のみ → coarse-only ノードは 0 になるが prims があれば処理する
            if (child.totalFaces > 0 || (child.prims && child.prims.length > 0)) {
                validChildren.push(await exportNodes(child, io, sourceDoc, globalParams));
            }
        }
        tile.children = validChildren;
    }
    return tile;
}

main().catch(console.error);
