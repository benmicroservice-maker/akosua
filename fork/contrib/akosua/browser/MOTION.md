# Akosua Motion System — why the UI moves the way it does

Researched 2026-10-20 (Material Motion, Apple HIG spring model, AI-streaming
UX patterns, WCAG 2.3.3). Implemented in `akosua.css` + `cards.ts` helpers.
Workbench tokens only; GPU properties only (transform/opacity).

## Tokens
| Token | Value | Used for |
| --- | --- | --- |
| `--akosua-dur-press` | 120ms | button/icon squash, card-head tap |
| `--akosua-dur-state` | 180ms | hover, borders, stepper settle |
| `--akosua-dur-in` | 240ms | card/message entrances (translateY 6px + fade) |
| `--akosua-dur-expand` | 260ms | tool-card body reveal, chevron spring |
| `--akosua-ease-out` | cubic-bezier(0.16,1,0.3,1) | entrances — fast start, soft landing |
| `--akosua-ease-spring` | cubic-bezier(0.34,1.56,0.64,1) | press/success overshoot — PHYSICAL only |

## Rules
1. Spring overshoot is earned by touch: presses, the send→stop morph pop, the
   success check pop. It never decorates passive content.
2. Every state change answers a question: did it land (`tapFeedback`), did it
   work (`popFeedback` + green border flash), did it fail (`shakeFeedback` +
   red flash), is it alive (streaming caret, typing dots, breathing stop).
3. Streaming text carries a blinking caret (`.akosua-streaming`) until the
   bubble finalizes — a paused stream must never look finished.
4. Entrances stagger at 45ms (cap 8) for lists (Brain sections); the log only
   auto-scrolls when the user is already near the tail.
5. Reduced motion (`prefers-reduced-motion: reduce`): spatial motion collapses
   to 120ms opacity fades; feedback (colour, caret at rest, full-width
   progress) remains. Nothing flashes >3/s; spinners are VS Code codicons.
6. Keyboard-initiated actions get no decorative motion; focus rings are
   always visible (`:focus-visible`).

## "Haptics" on desktop
There is no vibration API in the workbench. The haptic ILLUSION is the
120ms squash-and-spring-back on press + the success pop — the same trick
mobile uses visually when the motor is unavailable. If a future host exposes
real haptics, `tapFeedback` in cards.ts is the single seam to add it.
