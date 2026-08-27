/**
 * #15192, activation-order hypothesis: "the Orca unicode provider is not reached
 * in production, so Hangul lays out at the wrong width."
 *
 * These pin the measurements that close it. Every precomposed Hangul syllable is
 * two cells under xterm's Unicode 6 tables, its Unicode 11 tables, and Orca's
 * provider alike, so no activation order — provider, v11 fallback, or the
 * untouched v6 default — can change how a syllable is budgeted. Whatever moves
 * Korean text off its cells is not the unicode version.
 *
 * The version-sensitive and oracle-sensitive code points are pinned too, as the
 * complete list of Hangul-block characters where a width disagreement is even
 * available. None of them occur in modern Korean prose.
 */
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { activateOrcaTerminalUnicodeProvider } from "../../shared/terminal-unicode-provider";
import { isWideGlyph } from "./__fixtures__/terminal-wide-cell-grid";

const ORCA_UNICODE_VERSION = "orca-11-zwj";
const HANGUL_SYLLABLES_FIRST = 0xac00;
const HANGUL_SYLLABLES_LAST = 0xd7a3;

/** Jamo, Compatibility Jamo, Jamo Extended-A, Syllables + Extended-B, halfwidth jamo. */
const HANGUL_BLOCKS: [number, number][] = [
  [0x1100, 0x11ff],
  [0x3130, 0x318f],
  [0xa960, 0xa97f],
  [0xac00, 0xd7ff],
  [0xffa0, 0xffdc],
];

function* hangulCodePoints(): Generator<number> {
  for (const [first, last] of HANGUL_BLOCKS) {
    for (let cp = first; cp <= last; cp += 1) {
      yield cp;
    }
  }
}

type UnicodeServiceInternals = {
  versions: string[];
  activeVersion: string;
  wcwidth(codepoint: number): number;
  charProperties(codepoint: number, preceding: number): number;
};

/** Mirrors pane-lifecycle's openTerminal order: addon first, activation after. */
function openLikePaneLifecycle(): {
  terminal: Terminal;
  unicode: UnicodeServiceInternals;
} {
  const terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
  terminal.loadAddon(new Unicode11Addon());
  activateOrcaTerminalUnicodeProvider(terminal as never);
  const unicode = (
    terminal as unknown as {
      _core: { unicodeService: UnicodeServiceInternals };
    }
  )._core.unicodeService;
  return { terminal, unicode };
}

/** Width bits of xterm's packed char properties — what the buffer actually budgets. */
function propertyWidth(properties: number): number {
  return (properties >> 1) & 3;
}

function summarizeRanges(codepoints: number[]): string[] {
  const out: { start: number; end: number }[] = [];
  for (const codepoint of codepoints) {
    const last = out.at(-1);
    if (last && last.end === codepoint - 1) {
      last.end = codepoint;
      continue;
    }
    out.push({ start: codepoint, end: codepoint });
  }
  const hex = (value: number): string =>
    `U+${value.toString(16).toUpperCase().padStart(4, "0")}`;
  return out.map(({ start, end }) =>
    start === end ? hex(start) : `${hex(start)}..${hex(end)}`,
  );
}

describe("Hangul cell width agreement (#15192)", () => {
  it("reaches the Orca provider, not the v11 fallback, in pane-lifecycle order", () => {
    const { terminal, unicode } = openLikePaneLifecycle();
    expect(unicode.versions).toContain(ORCA_UNICODE_VERSION);
    expect(unicode.activeVersion).toBe(ORCA_UNICODE_VERSION);
    terminal.dispose();
  });

  it("budgets every precomposed syllable at two cells under v6, v11 and Orca", () => {
    const { terminal, unicode } = openLikePaneLifecycle();
    const disagreeing: number[] = [];
    for (const version of ["6", "11", ORCA_UNICODE_VERSION]) {
      unicode.activeVersion = version;
      for (
        let cp = HANGUL_SYLLABLES_FIRST;
        cp <= HANGUL_SYLLABLES_LAST;
        cp += 1
      ) {
        if (
          unicode.wcwidth(cp) !== 2 ||
          propertyWidth(unicode.charProperties(cp, 0)) !== 2
        ) {
          disagreeing.push(cp);
        }
      }
    }
    expect(summarizeRanges(disagreeing)).toEqual([]);
    terminal.dispose();
  });

  it("records where the wide-cell oracle diverges from xterm on conjoining jamo", () => {
    const { terminal, unicode } = openLikePaneLifecycle();
    const divergent: number[] = [];
    for (const cp of hangulCodePoints()) {
      const oracle = isWideGlyph(String.fromCodePoint(cp)) ? 2 : 1;
      if (unicode.wcwidth(cp) !== oracle) {
        divergent.push(cp);
      }
    }
    // Why pinned rather than fixed: xterm treats medial/final jamo as zero-width
    // combining marks, the oracle as one cell. Only decomposed (NFD) Korean can
    // reach them, and no fixture writes NFD today — so a fixture that adds it
    // would be asserting against a wrong oracle, and this is the tripwire. The
    // other two entries are the unassigned Compatibility Jamo edges and
    // Jamo Extended-A, neither of which occurs in Korean text.
    expect(summarizeRanges(divergent)).toEqual([
      "U+1160..U+11FF",
      "U+3130",
      "U+318F",
      "U+A960..U+A97C",
    ]);
    terminal.dispose();
  });
});
