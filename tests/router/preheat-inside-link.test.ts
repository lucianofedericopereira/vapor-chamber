// @vitest-environment happy-dom
/**
 * The pointer moving inside a link (onto its icon and back) keeps that link's warm-up delay.
 * Why: a hover warms a link's page after a delay; moving onto an icon inside the link fires mouseout then mouseover, and restarting the timer would make a user resting on a link with an icon wait longer than the delay.
 * Shows: a move within the link warms it once at 100 ms; leaving the link, from the link or from its icon, warms nothing; moving to another link warms that one at 160 ms.
 * See: log 36.21
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDomIntegration } from '@router/dom';

/** A link with an icon inside it, as a menu link often has. */
function link(href: string): { anchor: HTMLAnchorElement; icon: HTMLElement } {
  const anchor = document.createElement('a');
  anchor.href = href;
  const icon = document.createElement('span');
  anchor.appendChild(icon);
  document.body.appendChild(anchor);
  return { anchor, icon };
}

/** The events a browser fires when the pointer moves from `from` to `to`: out of one, over the other. */
function move(from: Element | null, to: Element): void {
  from?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }));
  to.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: from }));
}

/** Runs `steps` at their times (ms), then reports what had warmed at 100 ms, 160 ms and 500 ms. */
function warmedAt(steps: Array<[ms: number, step: () => void]>): { at100: string[]; at160: string[]; at500: string[] } {
  vi.useFakeTimers();
  const seen: string[] = [];
  const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate: vi.fn(), preheat: (p) => seen.push(p) });
  const snapshots: Record<number, string[]> = {};
  const marks: Array<[number, () => void]> = [...steps, [100, () => (snapshots[100] = [...seen])], [160, () => (snapshots[160] = [...seen])]];
  let now = 0;
  for (const [ms, step] of marks.sort((x, y) => x[0] - y[0])) {
    vi.advanceTimersByTime(ms - now);
    now = ms;
    step();
  }
  vi.advanceTimersByTime(500 - now);
  const at500 = [...seen];
  teardown();
  return { at100: snapshots[100], at160: snapshots[160], at500 };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('the pointer moving inside a link keeps its warm-up delay', () => {
  it('onto the link, then onto its icon at 60 ms: warmed once, at 100 ms', () => {
    const { anchor, icon } = link('/admin/a');
    expect(
      warmedAt([
        [0, () => move(document.body, anchor)],
        [60, () => move(anchor, icon)],
      ]),
    ).toEqual({ at100: ['/a'], at160: ['/a'], at500: ['/a'] });
  });

  it('onto the icon, back onto the link at 60 ms: warmed once, at 100 ms', () => {
    const { anchor, icon } = link('/admin/a');
    expect(
      warmedAt([
        [0, () => move(document.body, icon)],
        [60, () => move(icon, anchor)],
      ]),
    ).toEqual({ at100: ['/a'], at160: ['/a'], at500: ['/a'] });
  });

  it('control: the pointer leaves the link at 60 ms: nothing warms', () => {
    const { anchor } = link('/admin/a');
    expect(
      warmedAt([
        [0, () => move(document.body, anchor)],
        [60, () => move(anchor, document.body)],
      ]),
    ).toEqual({ at100: [], at160: [], at500: [] });
  });

  it('control: the pointer leaves the link from its icon at 60 ms: nothing warms', () => {
    const { anchor, icon } = link('/admin/a');
    expect(
      warmedAt([
        [0, () => move(document.body, anchor)],
        [30, () => move(anchor, icon)],
        [60, () => move(icon, document.body)],
      ]),
    ).toEqual({ at100: [], at160: [], at500: [] });
  });

  it('control: the pointer moves to another link at 60 ms: that link warms, at 160 ms', () => {
    const a = link('/admin/a');
    const b = link('/admin/b');
    expect(
      warmedAt([
        [0, () => move(document.body, a.anchor)],
        [60, () => move(a.anchor, b.icon)],
      ]),
    ).toEqual({ at100: [], at160: ['/b'], at500: ['/b'] });
  });
});
