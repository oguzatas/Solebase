# Design — Notes vault

## Scene

Evening desk, dim ambient light, one open note. Focus on the page, not chrome.

## Color strategy

Restrained. OKLCH-tinted charcoal neutrals; sage accent for selection and primary affordances only.

| Token | Value |
|-------|--------|
| `--bg` | `#101214` |
| `--bg-elev` | `#171a1e` |
| `--bg-panel` | `#14171b` |
| `--line` | `#2a3038` |
| `--text` | `#e4e7ec` |
| `--muted` | `#7a828e` |
| `--accent` | `#7a9e8a` |
| `--warn` | `#c4a574` |
| `--danger` | `#c97a7a` |

## Typography

One family: Figtree (system-ui fallback). Scale ~1.15. No display face in chrome.

## Layout

- Full-bleed editor
- Thin top toolbar (~2.5rem)
- Vault = left drawer (overlay)
- Context = right drawer (outline / backlinks)
- No permanent dual sidebars

## Components

- Icon buttons 32×32, 1px hairline only on focus/hover
- Single search in vault drawer
- Drawers: 16rem, slide 180–220ms ease-out
- Settings remains existing right drawer
