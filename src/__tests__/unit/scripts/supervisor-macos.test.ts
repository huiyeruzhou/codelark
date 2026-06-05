import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('macOS supervisor launchd label', () => {
  const scriptPath = path.join(process.cwd(), 'scripts', 'supervisor-macos.sh');

  it('uses only the CodeLark launchd label', () => {
    const script = fs.readFileSync(scriptPath, 'utf-8');

    assert.match(script, /LAUNCHD_LABEL="com\.codelark\.bridge"/);
    assert.doesNotMatch(script, /LEGACY_LAUNCHD_LABEL/);
    assert.doesNotMatch(script, /LEGACY_PLIST_FILE/);
  });
});
