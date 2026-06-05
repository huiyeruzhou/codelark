import fs from 'node:fs';

export function readFirstLine(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    let bytesReadTotal = 0;
    const buffer = Buffer.alloc(4096);

    while (bytesReadTotal < maxBytes) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, bytesReadTotal);
      if (bytesRead <= 0) break;

      const slice = Buffer.from(buffer.subarray(0, bytesRead));
      chunks.push(slice);
      bytesReadTotal += bytesRead;

      const newlineIndex = slice.indexOf(0x0a);
      if (newlineIndex !== -1) {
        const combined = Buffer.concat(chunks);
        return combined.subarray(0, combined.indexOf(0x0a)).toString('utf-8').replace(/\r$/, '');
      }
    }

    return Buffer.concat(chunks).toString('utf-8').split(/\r?\n/, 1)[0] || '';
  } finally {
    fs.closeSync(fd);
  }
}

export function readFilePrefix(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(maxBytes, 64 * 1024));
    const chunks: Buffer[] = [];
    let offset = 0;

    while (offset < maxBytes) {
      const bytesToRead = Math.min(buffer.length, maxBytes - offset);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
      if (bytesRead <= 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      offset += bytesRead;
    }

    return Buffer.concat(chunks).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

export function readFileUtf8Range(filePath: string, startOffset: number, endOffset: number): string {
  const safeStart = Math.max(0, startOffset);
  const safeEnd = Math.max(safeStart, endOffset);
  const bytesToRead = safeEnd - safeStart;
  if (bytesToRead <= 0) return '';

  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    let totalRead = 0;
    while (totalRead < bytesToRead) {
      const bytesRead = fs.readSync(fd, buffer, totalRead, bytesToRead - totalRead, safeStart + totalRead);
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
    }
    return buffer.subarray(0, totalRead).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}
