# 法兰螺栓分级扭矩服务

基于 Node.js + Express + better-sqlite3 的 HTTP 服务，按法兰通径（DN）与螺栓数生成
**分级对径交替紧固方案**：从 1 号螺栓起，与对径螺栓（位次相差螺栓数的一半）交替紧固，
逐级逐颗返回紧固序号与该级扭矩（比例 × 目标扭矩，四舍五入到 1 N·m），并落库供反查。

## 环境

- Node.js 20.18
- Express 4
- better-sqlite3

## 启动

```bash
npm install express better-sqlite3
node index.js
```

服务默认监听 `http://localhost:3000`（可用环境变量 `PORT` 改端口、`DB_PATH` 改 SQLite 文件路径，
数据库文件默认为运行目录下的 `flange.db`，首次启动自动建表）。

## 接口

### POST /api/v1/flange/torque

生成紧固方案并落库（同一 `dn` + `bolt_count` 重复提交会覆盖旧方案）。

请求体字段：

| 字段 | 说明 |
| --- | --- |
| `dn` | 法兰通径标识，如 `"DN100"` |
| `bolt_count` | 螺栓数，偶数，枚举 4 至 24（4, 6, 8, …, 24） |
| `target_torque` | 目标扭矩，正数，单位 N·m |
| `stages` | 分级比例数组（%），须严格递增且末项为 `100`，如 `[30, 70, 100]` |

校验不通过时返回 HTTP 400 与 `{ "ok": false, "reason": "..." }`，且不落库。

### GET /api/v1/flange/scheme

按 `dn` 与 `bolt_count` 查询参数反查已落库的同一方案；不存在返回 404。

## 示例请求

```bash
curl -s -X POST http://localhost:3000/api/v1/flange/torque \
  -H 'Content-Type: application/json' \
  -d '{"dn":"DN100","bolt_count":8,"target_torque":200,"stages":[30,70,100]}'
```

8 颗螺栓的紧固序列为对径交替的 `[1, 5, 2, 6, 3, 7, 4, 8]`，响应中 `steps` 逐级逐颗给出
每颗螺栓的紧固序号与扭矩（30%→60 N·m、70%→140 N·m、100%→200 N·m）。

反查同一方案：

```bash
curl -s 'http://localhost:3000/api/v1/flange/scheme?dn=DN100&bolt_count=8'
```
