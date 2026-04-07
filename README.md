# tiles-performance
## 東京圏における建築物 3D Tiles モデルの最適化

---

## 概要

本プロジェクトでは、[PLATEAU](https://www.mlit.go.jp/plateau/) からダウンロードした建築物の 3D Tiles モデルを対象に、表示パフォーマンスの改善を行いました。  
大規模モデルを効率的に読み込めるよう、タイル分割・LOD・テクスチャ圧縮などの最適化手法を適用しています。

---

## 背景

- PLATEAU の 3D Tiles を読み込む際、ブラウザがスムーズでなく、カクつきが発生
- 最大 50.6MB のタイルモデルにより、読み込み時にスレッドが一時停止する現象が確認された

---

## 技術的アプローチ（検討経緯）

| # | アプローチ | 結果 |
|---|-----------|------|
| 1 | PLATEAU の 3D Tiles を直接最適化 | 最大タイルはルートノードであり、分割不可 → **断念** |
| 2 | CityGML → GLTF 変換後に 3D Tiles 再生成 | 公式ツールでは全メッシュ統合 → 建物単位で分割不可 → **断念** |
| 3 | FBX / OBJ → GLTF → タイル分割による 3D Tiles 生成 | 実験で有効性を確認 → **採用** |

---

## 最適化ポイント

| 手法 | 詳細 |
|------|------|
| **タイルサイズ制御** | 各タイルのモデル面数を 5,000 以下に制限（`FACE_THRESHOLD = 5000`） |
| **KTX2 テクスチャ圧縮** | VRAM 使用量を約 80% 削減、メモリ使用量を約 30% 削減 |
| **LOD（Level of Detail）** | 遠距離：LOD1 のみ、近距離：LOD2 を読み込み（切り替え誤差 `LOD_SWITCH_ERROR = 20px`） |

---

## ディレクトリ構成

```
tiles-performance/
├── obj/                    # 入力データ（LOD ディレクトリを配置）
│   ├── lod1/               # coarse LOD（低精度モデル）
│   │   └── <buildingId>/   # 建物単位のサブフォルダ
│   └── lod2/               # fine LOD（高精度モデル）
│       └── <buildingId>/
├── dist/                   # 出力先（自動生成）
│   └── tiles/              # 生成された 3D Tiles
├── index.js                # メイン：3D Tiles 生成スクリプト
├── analyze-gltf.js         # GLTF 解析ツール
├── split-quadtree.js       # タイル分割可視化ツール
├── obj2gltf-batch.js       # OBJ → GLTF バッチ変換ツール
└── package.json
```

---

## セットアップ

### 必要環境

- Node.js 18+
- [`ktx`](https://github.com/KhronosGroup/KTX-Software) コマンドラインツール（KTX2 圧縮に使用）

### サンプルデータ

テスト用の OBJ サンプルデータ（東京圏）をこちらからダウンロードできます：

```
https://pub-6c9dee2a5eec41b688fd8d1482ccf5e4.r2.dev/tokyo_obj/obj.7z
```

ダウンロード後、`obj.7z` を解凍して `obj/` ディレクトリに配置してください。

### インストール

```bash
npm install
```

### 依存ライブラリ

| パッケージ | 用途 |
|-----------|------|
| `@gltf-transform/core` | GLTF ドキュメントの読み書き・操作 |
| `@gltf-transform/extensions` | KTX2 (Basis Universal) テクスチャ拡張 |
| `@gltf-transform/functions` | prune / dedup / weld / simplify 等の最適化関数 |
| `obj2gltf` | OBJ → GLTF 変換 |
| `cesium` | 座標変換（地理座標 → Cartesian3） |
| `proj4` | 投影変換 |
| `meshoptimizer` | メッシュ簡略化エンジン |

---

## 使い方

### 1. OBJ → GLTF バッチ変換

```bash
node obj2gltf-batch
```

`obj/` 配下のサブフォルダを走査し、OBJ ファイルを GLTF に一括変換します。

### 2. 3D Tiles 生成

```bash
node index
```

`obj/` 配下の LOD ディレクトリ構造を読み取り、タイル分割・LOD・KTX2 圧縮を適用した 3D Tiles を `dist/tiles/` に出力します。  
生成された `dist/tiles/tileset.json` は Cesium や deck.gl でそのまま使用可能です。

### 3. GLTF ファイル解析

```bash
node analyze-gltf <file>.gltf
```

指定した GLTF ファイルのメッシュ数・面数などの統計情報を表示します。

### 4. タイル分割の可視化

```bash
node split-quadtree <file>.gltf
```

Quadtree 形式のタイル構造・階層・LOD 適用状況を確認できます。

---

## 成果

- タイルサイズ制御 + LOD + テクスチャ圧縮により、ブラウザのカクつきが大幅に軽減
- 遠距離から近距離までスムーズに表示可能
- VRAM・メモリ使用量の大幅削減

---

## 最適化前後の比較

- [`tiles-performance-comparison`](https://github.com/Rosyo-gis/tiles-performance-comparison)最適化前の PLATEAU 3D Tiles と、本プロジェクトによる最適化後の表示比較は、こちらのページよりご確認いただけます。

---

## 今後の改善予定

- **LOD 遷移の改善**：LOD1 と LOD2 の形状差が大きいため、中間 LOD を生成して自然な遷移を実現
- **LOD とタイルの整合性**：LOD1 のみのエリアと LOD1+LOD2 混在エリアを分離してタイル分割
- **過小タイルの統合**：小さいタイルを隣接タイルと統合し、リクエスト数削減・読み込み速度改善
- **LOD1 の品質向上**：法線情報などを追加し、表示品質を改善
- **SSE の最適化**：LOD1 と LOD2 の切り替え時の不連続やちらつきを抑制し、スムーズな遷移を実現
- **配信最適化（CDN / キャッシュ）**：CDN を導入し、キャッシュ制御および HTTP/3 を活用することで、ネットワーク遅延の低減とリクエスト処理の高速化を図る
