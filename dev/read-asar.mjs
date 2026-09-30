import fs from 'node:fs';
const asar = process.argv[2];
const inner = process.argv[3];
const fd = fs.openSync(asar, 'r');
const pre = Buffer.alloc(16);
fs.readSync(fd, pre, 0, 16, 0);
const jsonLen = pre.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
const header = JSON.parse(jsonBuf.toString('utf8'));
const base = 8 + pre.readUInt32LE(4);
let node = header;
for (const part of inner.split('/')) {
  node = node.files?.[part];
  if (!node) { console.error('NOT FOUND at', part); process.exit(2); }
}
if (node.offset === undefined) { console.log(JSON.stringify(node, null, 2).slice(0, 3000)); process.exit(0); }
const size = Number(node.size);
const off = base + Number(node.offset);
const buf = Buffer.alloc(size);
fs.readSync(fd, buf, 0, size, off);
process.stdout.write(buf);
