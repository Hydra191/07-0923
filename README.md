# 法兰螺栓分级扭矩紧固方案服务

基于 Node.js 20.18 + Express + better-sqlite3，提供法兰螺栓分级紧固扭矩序列的计算与查询。

## 接口

### `POST /api/v1/flange/torque`

计算并落库紧固方案。请求体：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `dn` | string | 法兰公称通径标识，非空 |
| `bolt_count` | number | 螺栓数，偶数，取值 4、6、8 … 24 |
| `target_torque` | number | 目标扭矩，单位 N·m，须为正数 |
| `stages` | number[] | 分级比例（%），须严格递增，末项必须为 `100` |

- 每级扭矩 = 该级比例 × 目标扭矩，四舍五入到 1 N·m。
- 紧固序列自 1 号螺栓起，按相邻位次相差 `bolt_count / 2` 对径交替（星形法），例如 8 颗：1 → 5 → 2 → 6 → 3 → 7 → 4 → 8。
- 返回逐级逐颗的紧固步骤（`stage` / `percent` / `seq` / `bolt` / `torque`），并按 `(dn, bolt_count)` 落库（重复提交覆盖旧方案）。
- 螺栓数不在枚举、目标扭矩非正、分级比例非严格递增或末项非 100，均返回 `400` 与原因，且不落库。

### `GET /api/v1/flange/scheme?dn=...&bolt_count=...`

按 `dn` 与螺栓数反查已落库的同一序列，不存在返回 `404`。

## 启动

```bash
# Node 20.18
npm install express better-sqlite3
node index.js
# 服务默认监听 http://localhost:3000 ，可用 PORT 环境变量修改端口
```

## 示例请求

```bash
curl -s -X POST http://localhost:3000/api/v1/flange/torque \
  -H 'Content-Type: application/json' \
  -d '{"dn":"DN100","bolt_count":8,"target_torque":200,"stages":[30,60,100]}'
```

返回中 8 颗螺栓按 1、5、2、6、3、7、4、8 的对径次序，分别在 30%（60 N·m）、60%（120 N·m）、100%（200 N·m）三级下逐颗紧固，共 24 步。随后可用以下请求反查：

```bash
curl -s 'http://localhost:3000/api/v1/flange/scheme?dn=DN100&bolt_count=8'
```
