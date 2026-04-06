const { NodeIO } = require('@gltf-transform/core');
const path = require('path');
const fs = require('fs');

async function processQuadtree(fileName) {
    // 1. ファイルの存在確認
    const filePath = path.isAbsolute(fileName) ? fileName : path.join(process.cwd(), fileName);
    if (!fs.existsSync(filePath)) {
        console.error(`エラー: ファイルが見つかりません "${filePath}"`);
        process.exit(1);
    }

    const io = new NodeIO();
    const document = await io.read(filePath);
    const root = document.getRoot();

    // --- データ抽出フェーズ ---
    const allPrims = [];
    let globalMin = [Infinity, Infinity];
    let globalMax = [-Infinity, -Infinity];

    root.listMeshes().forEach(mesh => {
        mesh.listPrimitives().forEach(prim => {
            const pos = prim.getAttribute('POSITION');
            if (!pos) return;

            const min = pos.getMin([0, 0, 0]);
            const max = pos.getMax([0, 0, 0]);
            const indices = prim.getIndices();
            const faceCount = indices ? indices.getCount() / 3 : pos.getCount() / 3;

            const data = {
                prim,
                // 四分木判定用のXZ平面の中心点
                center: [(min[0] + max[0]) / 2, (min[2] + max[2]) / 2],
                faceCount: Math.round(faceCount)
            };
            allPrims.push(data);

            // 全体の境界ボックスを更新
            globalMin[0] = Math.min(globalMin[0], min[0]);
            globalMin[1] = Math.min(globalMin[1], min[2]);
            globalMax[0] = Math.max(globalMax[0], max[0]);
            globalMax[1] = Math.max(globalMax[1], max[2]);
        });
    });

    // --- 四分木分割フェーズ ---
    /**
     * @param {Array} prims 分割対象のPrimitiveリスト
     * @param {Array} min 領域の最小座標 [x, z]
     * @param {Array} max 領域の最大座標 [x, z]
     * @param {number} level 現在の深さ
     */
    function splitNode(prims, min, max, level = 0) {
        const totalFaces = prims.reduce((sum, p) => sum + p.faceCount, 0);

        // 停止条件: ポリゴン数が5,000以下、または要素が空の場合
        if (totalFaces <= 5000 || prims.length === 0) {
            return { level, totalFaces, prims, children: [] };
        }

        // 領域を4分割する中心線を計算
        const midX = (min[0] + max[0]) / 2;
        const midZ = (min[1] + max[1]) / 2;

        // 4つの象限(NW, NE, SW, SE)を定義
        const childBuckets = [
            { prims: [], min: [midX, midZ], max: [max[0], max[1]], name: 'NE' }, // 北東
            { prims: [], min: [min[0], midZ], max: [midX, max[1]], name: 'NW' }, // 北西
            { prims: [], min: [min[0], min[1]], max: [midX, midZ], name: 'SW' }, // 南西
            { prims: [], min: [midX, min[1]], max: [max[0], midZ], name: 'SE' }  // 南東
        ];

        // 各Primitiveを中心に基いて象限に振り分け
        prims.forEach(p => {
            const [x, z] = p.center;
            let targetIdx;
            if (x > midX && z > midZ) targetIdx = 0;
            else if (x <= midX && z > midZ) targetIdx = 1;
            else if (x <= midX && z <= midZ) targetIdx = 2;
            else targetIdx = 3;

            childBuckets[targetIdx].prims.push(p);
        });

        // 子ノードに対して再帰的に分割を実行
        return {
            level,
            totalFaces,
            center: [midX, midZ],
            children: childBuckets.map(b => splitNode(b.prims, b.min, b.max, level + 1))
        };
    }

    // 実行
    const tree = splitNode(allPrims, globalMin, globalMax);
    console.log(`\n--- [${path.basename(fileName)}] 四分木解析完了 ---`);
    printTreeSummary(tree);
}

/**
 * 解析結果をコンソールにツリー形式で表示
 */
function printTreeSummary(node, prefix = '') {
    if (node.children.length === 0) {
        if (node.totalFaces > 0) {
            console.log(`${prefix}🍃 葉ノード: Level ${node.level}, ポリゴン数: ${node.totalFaces.toLocaleString()}, 要素数: ${node.prims.length}`);
        }
    } else {
        console.log(`${prefix}📂 分割ノード: Level ${node.level}, 合計ポリゴン数: ${node.totalFaces.toLocaleString()}`);
        node.children.forEach(child => printTreeSummary(child, prefix + '  '));
    }
}

// 実行コマンド: node quadtree.js <ファイル名>
const inputFileName = process.argv[2];

if (!inputFileName) {
    console.log('使用法: node quadtree.js <gltfファイル名>');
} else {
    processQuadtree(inputFileName).catch(err => console.error(err));
}