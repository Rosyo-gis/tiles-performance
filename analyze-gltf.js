const { NodeIO } = require('@gltf-transform/core');
const path = require('path');
const fs = require('fs');

// GLTFファイルを解析して、メッシュの頂点数、ポリゴン数、バウンディングボックス、中心点などの情報を収集する関数
async function analyzeMeshesForQuadtree(fileName) {
    // 1. ファイルの存在確認
    const filePath = path.isAbsolute(fileName) ? fileName : path.join(process.cwd(), fileName);
    if (!fs.existsSync(filePath)) {
        console.error(`エラー: ファイルが見つかりません "${filePath}"`);
        process.exit(1);
    }

    const io = new NodeIO();
    const document = await io.read(filePath);
    const root = document.getRoot();

    const meshStats = [];

    // 全てのメッシュを走査
    root.listMeshes().forEach((mesh) => {
        let totalIndices = 0;
        let totalVertices = 0;
        let meshMin = [Infinity, Infinity, Infinity];
        let meshMax = [-Infinity, -Infinity, -Infinity];

        mesh.listPrimitives().forEach((prim) => {
            const indices = prim.getIndices();
            const position = prim.getAttribute('POSITION');

            // 頂点数のカウント
            if (position) {
                const count = position.getCount();
                totalVertices += count;

                // バウンディングボックスの更新
                const min = position.getMin([0, 0, 0]);
                const max = position.getMax([0, 0, 0]);
                for (let i = 0; i < 3; i++) {
                    meshMin[i] = Math.min(meshMin[i], min[i]);
                    meshMax[i] = Math.max(meshMax[i], max[i]);
                }
            }

            // 面数（ポリゴン数）の計算用インデックスカウント
            if (indices) {
                totalIndices += indices.getCount();
            } else if (position) {
                // インデックスがない場合は頂点数を使用
                totalIndices += position.getCount();
            }
        });

        meshStats.push({
            name: mesh.getName() || '名称未設定',
            vertexCount: totalVertices,
            faceCount: Math.round(totalIndices / 3),
            box: { min: meshMin, max: meshMax },
            center: [
                (meshMin[0] + meshMax[0]) / 2,
                (meshMin[2] + meshMax[2]) / 2 // XZ平面の中心
            ]
        });
    });

    console.log(`\n--- [${path.basename(fileName)}] 詳細分析レポート ---`);
    if (meshStats.length === 0) {
        console.log('有効なメッシュデータが見つかりませんでした。');
    } else {
        console.table(meshStats.map(s => ({
            "メッシュ名": s.name,
            "頂点数": s.vertexCount.toLocaleString(), // カンマ区切り
            "ポリゴン数": s.faceCount.toLocaleString(),
            "中心点_X": s.center[0].toFixed(2),
            "中心点_Z": s.center[1].toFixed(2)
        })));
    }

    return meshStats;
}

const inputFileName = process.argv[2];

if (!inputFileName) {
    console.log('使用法: node analyze.js <gltfファイル名>');
} else {
    analyzeMeshesForQuadtree(inputFileName).catch((err) => {
        console.error('解析中にエラーが発生しました:', err);
    });
}