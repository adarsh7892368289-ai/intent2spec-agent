import { describe, it, expect } from 'vitest';
import path from 'node:path';

import { isPathContained, resolveContainedPath } from '@security/path-guards.js';

// SECURITY-CRITICAL: path containment guards.
//
// path.resolve is platform-sensitive (sep is '\' on win32, '/' on posix; a
// bare '/root' resolves against the current drive on Windows). Every expected
// value is therefore built with the real node `path` module rather than
// hard-coded, so the suite is correct on win32 and posix alike.

const ROOT = '/root';
const RESOLVED_ROOT = path.resolve(ROOT);
const SEP = path.sep;

// Backslash literal built without escapes so heredoc/shell quoting can't corrupt it.
const BS = String.fromCharCode(92);
const NUL = String.fromCharCode(0);

describe('path-guards: isPathContained', () => {
  describe('containment (happy path)', () => {
    it('returns true for a file directly under root', () => {
      expect(isPathContained(ROOT, path.resolve(ROOT, 'file.txt'))).toBe(true);
    });

    it('returns true for a nested file under root', () => {
      expect(isPathContained(ROOT, path.resolve(ROOT, 'a', 'b', 'c.txt'))).toBe(true);
    });

    it('returns true for an exact match of root itself', () => {
      expect(isPathContained(ROOT, RESOLVED_ROOT)).toBe(true);
    });

    it('returns true for root with a trailing separator', () => {
      expect(isPathContained(ROOT, RESOLVED_ROOT + SEP)).toBe(true);
    });

    it('returns true when the root argument carries a trailing separator', () => {
      expect(isPathContained(ROOT + '/', path.resolve(ROOT, 'file.txt'))).toBe(true);
    });
  });

  describe('rejection of non-contained paths', () => {
    it('returns false for a sibling directory sharing a name prefix (/root vs /root2)', () => {
      // The classic prefix-sibling bypass: '/root2' startsWith '/root' but is
      // NOT inside '/root'. The trailing-separator check must defeat this.
      const sibling = path.resolve('/root2', 'file.txt');
      expect(isPathContained(ROOT, sibling)).toBe(false);
    });

    it('returns false for an unrelated path', () => {
      expect(isPathContained(ROOT, path.resolve('/other', 'path'))).toBe(false);
    });

    it('returns false for a ".." traversal that escapes root', () => {
      // '/root/../etc/passwd' resolves to '/etc/passwd', outside root.
      expect(isPathContained(ROOT, '/root/../etc/passwd')).toBe(false);
    });

    it('returns false for a deep ".." chain that climbs above root', () => {
      const escaped = path.resolve(ROOT, '..', '..', '..', 'etc', 'passwd');
      expect(isPathContained(ROOT, escaped)).toBe(false);
    });
  });

  describe('input validation (fails closed)', () => {
    it('returns false when candidate is null', () => {
      expect(isPathContained(ROOT, null)).toBe(false);
    });

    it('returns false when root is null', () => {
      expect(isPathContained(null, '/root/file')).toBe(false);
    });

    it('returns false when root is a non-string', () => {
      expect(isPathContained(123, ROOT)).toBe(false);
    });

    it('returns false when candidate is a number', () => {
      expect(isPathContained(ROOT, 123)).toBe(false);
    });

    it('returns false when candidate is undefined', () => {
      expect(isPathContained(ROOT, undefined)).toBe(false);
    });

    it('returns false when both args are objects', () => {
      expect(isPathContained({}, [])).toBe(false);
    });
  });

  describe('separator / normalization edge cases', () => {
    it('treats redundant separators in the candidate as still contained', () => {
      const messy = RESOLVED_ROOT + SEP + SEP + 'file.txt';
      expect(isPathContained(ROOT, messy)).toBe(true);
    });

    it('does not treat root as containing a path that only shares a substring', () => {
      // '<root>file.txt' must not be considered inside '<root>'.
      const adjacent = RESOLVED_ROOT + 'file.txt';
      expect(isPathContained(ROOT, adjacent)).toBe(false);
    });
  });
});

describe('path-guards: resolveContainedPath', () => {
  describe('resolves legitimate relative paths inside root', () => {
    it('resolves a plain filename under root', () => {
      expect(resolveContainedPath(ROOT, 'file.txt')).toBe(path.resolve(ROOT, 'file.txt'));
    });

    it('resolves a nested relative path under root', () => {
      expect(resolveContainedPath(ROOT, 'subdir/file.txt')).toBe(
        path.resolve(ROOT, 'subdir', 'file.txt'),
      );
    });

    it('normalizes an in-bounds ".." that stays inside root', () => {
      // subdir/../file.txt collapses to file.txt — still contained.
      expect(resolveContainedPath(ROOT, 'subdir/../file.txt')).toBe(
        path.resolve(ROOT, 'file.txt'),
      );
    });
  });

  describe('leading-slash stripping (treat input as relative, not absolute)', () => {
    it('strips a single leading slash so the input cannot escape via absolute path', () => {
      expect(resolveContainedPath(ROOT, '/file.txt')).toBe(path.resolve(ROOT, 'file.txt'));
    });

    it('strips multiple leading slashes', () => {
      expect(resolveContainedPath(ROOT, '///file.txt')).toBe(path.resolve(ROOT, 'file.txt'));
    });
  });

  describe('null / undefined / empty inputs coerce to root', () => {
    it('treats null as empty string and returns root', () => {
      expect(resolveContainedPath(ROOT, null)).toBe(RESOLVED_ROOT);
    });

    it('treats undefined as empty string and returns root', () => {
      expect(resolveContainedPath(ROOT, undefined)).toBe(RESOLVED_ROOT);
    });

    it('treats empty string as root', () => {
      expect(resolveContainedPath(ROOT, '')).toBe(RESOLVED_ROOT);
    });
  });

  describe('adversarial traversal — must return null (fail closed)', () => {
    it('rejects a forward-slash ".." escape', () => {
      expect(resolveContainedPath(ROOT, '../etc/passwd')).toBeNull();
    });

    it('rejects a URL-encoded ".." escape (%2e%2e)', () => {
      // %2e%2e decodes to '..', then resolves above root.
      expect(resolveContainedPath(ROOT, '%2e%2e/etc/passwd')).toBeNull();
    });

    it('rejects a URL-encoded slash + ".." escape (%2e%2e%2f)', () => {
      expect(resolveContainedPath(ROOT, '%2e%2e%2fetc%2fpasswd')).toBeNull();
    });

    it('rejects a deeply chained ".." escape', () => {
      expect(resolveContainedPath(ROOT, '../../../../../../etc/passwd')).toBeNull();
    });

    it('rejects a backslash ".." escape', () => {
      // On win32 path.resolve treats '\' as a separator, so '..\etc' is a real
      // traversal and must be rejected. On posix '..\etc' is a single odd
      // filename that stays contained — assert against the resolved truth so the
      // test is correct on both platforms.
      const input = '..' + BS + 'etc';
      const result = resolveContainedPath(ROOT, input);
      if (SEP === BS) {
        expect(result).toBeNull();
      } else {
        expect(result).toBe(path.resolve(ROOT, input));
      }
    });

    it('rejects a chained backslash ".." escape', () => {
      const input = 'subdir' + BS + '..' + BS + '..' + BS + 'etc';
      const result = resolveContainedPath(ROOT, input);
      if (SEP === BS) {
        expect(result).toBeNull();
      } else {
        expect(result).toBe(path.resolve(ROOT, input));
      }
    });

    it('rejects a leading-backslash absolute-style path on win32', () => {
      const input = BS + 'Windows' + BS + 'system32';
      const result = resolveContainedPath(ROOT, input);
      if (SEP === BS) {
        // Leading forward slashes are stripped, but a backslash root makes this
        // an absolute path on win32 that path.resolve sends to the drive root —
        // outside ROOT.
        expect(result).toBeNull();
      } else {
        expect(result).toBe(path.resolve(ROOT, input));
      }
    });

    it('rejects a Windows drive-letter absolute path that escapes root', () => {
      const input = 'C:' + BS + 'Windows' + BS + 'system32';
      const result = resolveContainedPath(ROOT, input);
      if (SEP === BS) {
        expect(result).toBeNull();
      } else {
        // On posix 'C:\\Windows...' is just a filename, contained under root.
        expect(result).toBe(path.resolve(ROOT, input));
      }
    });

    it('does NOT escape on double-encoded traversal (single decode keeps it literal)', () => {
      // %252e%252e decodes ONCE to the literal text '%2e%2e', a harmless
      // directory name — NOT '..'. The guard must keep it contained and never
      // double-decode. Assert it stays inside root rather than escaping.
      const result = resolveContainedPath(ROOT, '%252e%252e/etc');
      expect(result).not.toBeNull();
      expect(isPathContained(ROOT, result)).toBe(true);
      expect(result).toBe(path.resolve(ROOT, '%2e%2e', 'etc'));
    });

    it('keeps a resolved result that is genuinely inside root (sanity: guard agrees)', () => {
      const result = resolveContainedPath(ROOT, 'a/b/c.txt');
      expect(result).not.toBeNull();
      expect(isPathContained(ROOT, result)).toBe(true);
    });
  });

  describe('type coercion of relativePath', () => {
    it('coerces a number to its string form and resolves it under root', () => {
      // String(123) === '123' resolves to <root>/123, which is contained.
      // (The brief speculated this returns null; the source actually — and
      // safely — keeps it inside root. Containment is preserved, so this is
      // acceptable behavior, asserted against the real resolved value.)
      const result = resolveContainedPath(ROOT, 123);
      expect(result).toBe(path.resolve(ROOT, '123'));
      expect(isPathContained(ROOT, result)).toBe(true);
    });
  });

  describe('embedded null byte (poison-null-byte surface)', () => {
    it('passes a decoded null byte through into the contained path (does NOT sanitize it)', () => {
      // file%00.txt decodes to 'file\0.txt'. The guard only enforces
      // CONTAINMENT, not byte hygiene: it returns a contained path that still
      // carries an embedded NUL. This is the actual behavior — documented as a
      // hardening gap (a downstream native fs call could be truncated at \0),
      // but it does not breach containment, so it is asserted, not failed.
      const result = resolveContainedPath(ROOT, 'file%00.txt');
      expect(result).not.toBeNull();
      expect(result).toContain(NUL);
      expect(isPathContained(ROOT, result)).toBe(true);
    });
  });

  describe('malformed percent-encoding (SECURITY: fails closed, does not throw)', () => {
    // A path guard MUST NOT throw on hostile input — it returns null so the
    // caller denies the request. decodeURIComponent throws URIError on malformed
    // sequences (lone '%', '%ZZ', truncated '%E0'); the guard catches that and
    // fails closed. (Regression test for the fixed crash bug.)

    it('returns null for a lone percent sign instead of throwing URIError', () => {
      expect(resolveContainedPath(ROOT, '%')).toBeNull();
    });

    it('returns null for an invalid percent escape (%ZZ) instead of throwing', () => {
      expect(resolveContainedPath(ROOT, '%ZZ/file.txt')).toBeNull();
    });

    it('returns null for a truncated percent escape (trailing %E0) instead of throwing', () => {
      expect(resolveContainedPath(ROOT, 'dir/%E0')).toBeNull();
    });

    it('never throws on malformed input (fails closed)', () => {
      expect(() => resolveContainedPath(ROOT, '%')).not.toThrow();
      expect(() => resolveContainedPath(ROOT, '%ZZ')).not.toThrow();
      expect(() => resolveContainedPath(ROOT, 'a/%E0')).not.toThrow();
    });
  });
});
