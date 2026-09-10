// api.js - renders docs/api/*.md into index.html. Committed and static: the
// generator (scripts/generate-api-docs.mjs) emits Markdown only and never
// writes HTML, so this file is the whole presentation layer and restyling the
// site does not regenerate a single documentation page.
//
// NO innerHTML ANYWHERE, deliberately, following the same rule as treegen2's
// changelog.js: every node is built with createElement/textContent, so nothing
// fetched from a .md file can ever be interpreted as markup and no manual
// escaping is needed. The reference is dense with generic signatures full of
// angle brackets, which is exactly the input that punishes a string-concat
// renderer.
//
// THE MARKDOWN SUBSET IS NOT ARBITRARY. Almost all of this input is emitted by
// generate-api-docs.mjs, so the constructs are a closed set: headings, fenced
// code, tables, links, inline code, bold, blockquotes, lists, paragraphs. The
// one genuinely open input is the text of the doc comments themselves, which is
// why those constructs are supported at all rather than only the generator's.
// Anything outside the set renders as literal text, which is the right failure
// for a viewer: visible, and harmless.

(function () {
  'use strict';

  var body = document.body;
  var SOURCE = (body.dataset.source || 'docs/api').replace(/\/$/, '');
  var navEl = document.getElementById('nav');
  var tocEl = document.getElementById('toc');
  var docEl = document.getElementById('doc');

  /** Same slug rule as generate-api-docs.mjs, so its `#anchor` links resolve. */
  function anchor(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /**
   * Scrolls `node` into view WITHIN `container` and nowhere else.
   *
   * Not `scrollIntoView`: that walks every scrollable ancestor, the document
   * included, so the scroll-spy marking a row while the reader scrolled was
   * also nudging the page - the column appeared to drag the content with it.
   * Adjusting scrollTop by hand touches exactly one box.
   */
  function keepInView(container, node) {
    var box = container.getBoundingClientRect();
    var item = node.getBoundingClientRect();
    if (item.top < box.top) container.scrollTop -= box.top - item.top;
    else if (item.bottom > box.bottom) container.scrollTop += item.bottom - box.bottom;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * The outbound marker on a link that leaves the reference (a source line on
   * GitHub, an upstream issue). Drawn rather than typed: the north-east arrow
   * character is exactly the typographic set scripts/check-ascii.mjs bans, and
   * a glyph would also inherit the font's weight instead of the link's.
   */
  function externalIcon() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ext');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M9 5 H19 V15 M19 5 L7 17');
    svg.appendChild(path);
    return svg;
  }

  // ---------- markdown ----------

  // Appends an inline run as real nodes. A `.md` link becomes an in-app link so
  // navigation stays on this page; an absolute one opens in a new tab.
  //
  // The regex is declared INSIDE the function, as treegen2's changelog.js does
  // it, and that is load-bearing rather than stylistic: this function recurses
  // for link labels, and a shared /g regex hoisted to module scope has one
  // lastIndex for both frames. The inner call rewound it and the outer loop
  // stopped terminating - the page hung on "Loading the reference...".
  function appendInline(container, raw) {
    var pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
    var last = 0;
    var match;
    while ((match = pattern.exec(raw))) {
      if (match.index > last) container.appendChild(document.createTextNode(raw.slice(last, match.index)));
      if (match[1] !== undefined) {
        container.appendChild(el('code', null, match[1]));
      } else if (match[2] !== undefined) {
        // A Contents label ("Functions:") takes its kind colour.
        var boldKind = PLURALS[match[2].replace(/:$/, '')];
        container.appendChild(el('strong', boldKind ? 'k-' + boldKind : null, match[2]));
      } else {
        // The LABEL is inline markdown too, and recursing rather than assigning
        // it as text is not a detail: nearly every link in the reference is a
        // symbol name wrapped in backticks, and setting textContent printed 194
        // literal backticks across the main page.
        var link = el('a');
        var href = match[4];
        var linkKind = href.charAt(0) === '#' ? kindByAnchor[href.slice(1)] : null;

        // With an icon the label goes in its own span, so the hover underline
        // can be put on the NAME alone: decorating the whole anchor draws the
        // rule straight through the icon's square.
        var label = linkKind ? el('span', 'link-text') : link;
        appendInline(label, match[3]);
        if (linkKind) {
          // The kind class goes on the ANCHOR so --kind-fg resolves for the
          // icon and the name together.
          link.className = 'k-' + linkKind;
          link.appendChild(kindIcon(linkKind));
          link.appendChild(label);
        }

        if (/^https?:/.test(href)) {
          link.href = href;
          link.target = '_blank';
          link.rel = 'noreferrer';
          // Marked, because it opens a new tab and leaves the reference: the
          // source links in particular look identical to in-page ones.
          link.classList.add('external');
          link.appendChild(externalIcon());
        } else if (href.charAt(0) === '#') {
          // An in-page anchor has to carry the page with it. The route lives in
          // the hash, so a bare `#symbol` REPLACES it, and every "Contents"
          // link navigated back to the overview instead of scrolling.
          link.href = '#/' + currentPage + href;
        } else {
          link.href = '#/' + href.replace(/\.md$/, '');
        }
        container.appendChild(link);
      }
      last = match.index + match[0].length;
    }
    if (last < raw.length) container.appendChild(document.createTextNode(raw.slice(last)));
  }

  // A cell may contain an escaped pipe, which is data rather than a column
  // break: the type column is full of them (`string \| undefined`).
  function splitRow(row) {
    var cells = row.replace(/^\||\|$/g, '').split(/(?<!\\)\|/);
    return cells.map(function (cell) {
      return cell.trim().replace(/\\\|/g, '|');
    });
  }

  // ---------- syntax highlighting ----------
  //
  // typedoc shipped shiki for this; a TypeScript-only highlighter for
  // signatures and short samples is a tokenizer, not a dependency. The corpus
  // is narrow - almost every block is a declaration or a small example - so
  // comments, strings, keywords, numbers and type-position identifiers cover
  // it, and anything unmatched simply stays plain text.
  //
  // Order in the alternation IS the precedence: comments and strings come
  // first so a keyword inside either is not re-coloured.
  var TOKENS = new RegExp(
    [
      '(//[^\\n]*|/\\*[\\s\\S]*?\\*/)', // 1 comment
      '(`(?:\\\\.|[^`\\\\])*`|\'(?:\\\\.|[^\'\\\\])*\'|"(?:\\\\.|[^"\\\\])*")', // 2 string
      '\\b(import|export|from|const|let|var|function|return|type|interface|extends|implements|readonly|new|async|await|void|null|undefined|true|false|if|else|for|of|in|typeof|keyof|as|declare|class|enum|namespace|default|this|super|throw|try|catch|finally|switch|case|break|continue|do|while|yield|satisfies|infer|is|asserts|abstract|static|public|private|protected|get|set)\\b', // 3 keyword
      '\\b(\\d[\\d_]*(?:\\.\\d+)?)\\b', // 4 number
      '\\b([A-Z][A-Za-z0-9_]*)\\b', // 5 type-ish identifier
      '([A-Za-z_$][A-Za-z0-9_$]*)(?=\\s*\\()', // 6 call
    ].join('|'),
    'g',
  );

  var TOKEN_CLASS = { 1: 'tok-comment', 2: 'tok-string', 3: 'tok-keyword', 4: 'tok-number', 5: 'tok-type', 6: 'tok-call' };

  function highlight(code, lang) {
    var node = el('code', lang ? 'lang-' + lang : null);
    if (lang && lang !== 'ts' && lang !== 'typescript' && lang !== 'js' && lang !== 'javascript') {
      node.textContent = code;
      return node;
    }
    var pattern = new RegExp(TOKENS.source, 'g');
    var last = 0;
    var match;
    while ((match = pattern.exec(code))) {
      if (match.index > last) node.appendChild(document.createTextNode(code.slice(last, match.index)));
      for (var group = 1; group <= 6; group++) {
        if (match[group] !== undefined) {
          node.appendChild(el('span', TOKEN_CLASS[group], match[group]));
          break;
        }
      }
      last = match.index + match[0].length;
    }
    if (last < code.length) node.appendChild(document.createTextNode(code.slice(last)));
    return node;
  }

  // The kinds generate-api-docs.mjs labels a symbol with. Colour is a
  // CONVENTION here, the way typedoc uses it: the badge beside a name says
  // function / class / interface / type alias without the reader parsing the
  // signature, and the same hue repeats in the sidebar dots and the search
  // results so one colour means one thing everywhere on the site.
  var KINDS = {
    Function: 'function',
    Class: 'class',
    Interface: 'interface',
    'Type alias': 'type',
    Enum: 'enum',
    Variable: 'variable',
    Namespace: 'namespace',
    Value: 'value',
  };

  // The initials are typedoc's, from its icons.svg: a square outlined in the
  // kind colour with F / C / I / T / E / V / N inside. Reusing the letters
  // rather than inventing glyphs means a reader who knows any TypeScript doc
  // site already knows this legend.
  var INITIALS = {
    function: 'F',
    class: 'C',
    interface: 'I',
    type: 'T',
    enum: 'E',
    variable: 'V',
    namespace: 'N',
    module: 'M',
    project: 'P',
    value: 'V',
  };

  /**
   * Plural group label -> kind, for the section headings and the "Functions:"
   * labels in Contents. Those carry the hue now instead of every link: the
   * icon already says what a symbol is, so colouring 193 names repeated the
   * same fact while costing the uniform blue that says "this is a link".
   */
  var PLURALS = {
    Functions: 'function',
    Classes: 'class',
    Interfaces: 'interface',
    'Type aliases': 'type',
    Enums: 'enum',
    Variables: 'variable',
    Namespaces: 'namespace',
  };

  function kindIcon(kind) {
    var icon = el('span', 'icon k-' + kind, INITIALS[kind] || '?');
    icon.title = kind;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
  }

  /**
   * anchor -> kind for the page being rendered, built BEFORE rendering.
   * The Contents block sits above the sections it links to, so the kind of a
   * symbol is not yet known when its link is emitted; a pre-scan is what lets
   * those links carry an icon at all.
   */
  var kindByAnchor = {};

  function scanKinds(markdown) {
    var map = {};
    var pending = null;
    markdown.split('\n').forEach(function (line) {
      var heading = /^###\s+(.*)$/.exec(line);
      if (heading) {
        pending = anchor(heading[1].replace(/`/g, '').trim());
        return;
      }
      var kind = /^\*\*([A-Za-z ]+)\*\*/.exec(line);
      if (pending && kind && KINDS[kind[1]]) {
        map[pending] = KINDS[kind[1]];
        pending = null;
      }
    });
    return map;
  }

  function render(markdown, target) {
    kindByAnchor = scanKinds(markdown);
    var lines = markdown.split('\n');
    var paragraph = [];
    var list = null;
    var headings = [];
    var lastHeading = null;

    function flushParagraph() {
      if (!paragraph.length) return;
      var raw = paragraph.join(' ');
      var p = el('p');

      // The generator writes the kind line as `**Function** - <source link>`.
      // Recognising it here keeps the Markdown plain (it reads correctly on
      // GitHub, which has no styles) while the site still gets a badge.
      // A Contents row is laid out as label + items in two columns, not as one
      // wrapped paragraph. Inline, the entries after a short label like
      // "Functions:" start at a different x from those after "Type aliases:",
      // and every wrapped line falls back under the label instead of lining up
      // with the entries above it.
      var contents = /^\*\*([A-Za-z ]+):\*\*\s*([\s\S]*)$/.exec(raw);
      if (contents && PLURALS[contents[1]]) {
        var row = el('div', 'contents-row');
        row.appendChild(el('span', 'contents-label k-' + PLURALS[contents[1]], contents[1]));
        var items = el('span', 'contents-items');
        appendInline(items, contents[2]);
        row.appendChild(items);
        target.appendChild(row);
        paragraph = [];
        return;
      }

      var kindMatch = /^\*\*([A-Za-z ]+)\*\*(?:\s-\s([\s\S]*))?$/.exec(raw);
      if (kindMatch && KINDS[kindMatch[1]] && lastHeading && !lastHeading.kind) {
        var slug = KINDS[kindMatch[1]];
        lastHeading.kind = slug;
        lastHeading.node.appendChild(el('span', 'badge k-' + slug, kindMatch[1]));
        // What follows the kind is the source link, which stays as a line of
        // its own; a kind with nothing after it contributes no paragraph.
        if (kindMatch[2]) {
          p.className = 'source';
          appendInline(p, kindMatch[2]);
          target.appendChild(p);
        }
        paragraph = [];
        return;
      }

      appendInline(p, raw);
      target.appendChild(p);
      paragraph = [];
    }

    function flushList() {
      if (!list) return;
      var ul = el('ul');
      list.forEach(function (item) {
        var li = el('li');
        appendInline(li, item);
        ul.appendChild(li);
      });
      target.appendChild(ul);
      list = null;
    }

    function flush() {
      flushParagraph();
      flushList();
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      if (!line.trim() || line.indexOf('<!--') === 0) {
        flush();
        continue;
      }

      // Fenced code first: no inline rule may rewrite the inside of a sample.
      if (line.indexOf('```') === 0) {
        flush();
        var lang = line.slice(3).trim();
        var code = [];
        i++;
        while (i < lines.length && lines[i].indexOf('```') !== 0) code.push(lines[i++]);
        var pre = el('pre');
        pre.appendChild(highlight(code.join('\n'), lang));
        target.appendChild(pre);
        continue;
      }

      var heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flush();
        var level = heading[1].length;
        var plain = heading[2].replace(/`/g, '');
        var h = el('h' + level);
        if (level === 2 && PLURALS[plain]) h.className = 'k-' + PLURALS[plain];
        h.id = anchor(plain);
        appendInline(h, heading[2]);
        target.appendChild(h);
        if (level === 2 || level === 3) {
          lastHeading = { text: plain, id: h.id, level: level, kind: null, node: h };
          headings.push(lastHeading);
        }
        continue;
      }

      // A table is a header row followed by the delimiter row.
      if (line.charAt(0) === '|' && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
        flush();
        var table = el('table');
        var thead = el('thead');
        var headRow = el('tr');
        splitRow(line).forEach(function (cell) {
          var th = el('th');
          appendInline(th, cell);
          headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = el('tbody');
        i += 2;
        while (i < lines.length && lines[i].charAt(0) === '|') {
          var tr = el('tr');
          splitRow(lines[i]).forEach(function (cell) {
            var td = el('td');
            appendInline(td, cell);
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
          i++;
        }
        i--;
        table.appendChild(tbody);
        target.appendChild(table);
        continue;
      }

      if (line.indexOf('> ') === 0) {
        flush();
        var quote = el('blockquote');
        appendInline(quote, line.slice(2));
        target.appendChild(quote);
        continue;
      }

      var item = line.match(/^\s*[-*]\s+(.*)$/);
      if (item) {
        flushParagraph();
        (list || (list = [])).push(item[1]);
        continue;
      }

      flushList();
      paragraph.push(line.trim());
    }

    flush();
    return headings;
  }

  // ---------- pages ----------

  var pages = [];
  var cache = {};
  /** The page currently rendered, so in-page anchors can be namespaced to it. */
  var currentPage = 'README';

  function fetchPage(name) {
    if (cache[name]) return cache[name];
    cache[name] = fetch(SOURCE + '/' + name + '.md').then(function (res) {
      if (!res.ok) throw new Error(res.status + ' ' + name);
      return res.text();
    });
    return cache[name];
  }

  // The entry-point list comes from the generated overview table rather than a
  // second hand-kept list here: one source, and a new subpath appears in the
  // sidebar the moment `npm run docs` writes it.
  function parseIndex(markdown) {
    var rows = markdown.split('\n').filter(function (line) {
      return line.charAt(0) === '|' && line.indexOf('](') !== -1;
    });
    return rows
      .map(function (row) {
        var cells = splitRow(row);
        var link = /\[`([^`]+)`\]\(([^)]+)\.md\)/.exec(cells[0] || '');
        if (!link) return null;
        return { specifier: link[1], name: link[2], count: (cells[2] || '').trim() };
      })
      .filter(Boolean);
  }

  function buildNav(current) {
    navEl.textContent = '';
    var overview = el('a', 'k-project' + (current === 'README' ? ' active' : ''));
    overview.href = '#/README';
    // Carries an icon like every other row: without one its label started at
    // the left edge while the 23 below it started after their square, so the
    // column of names did not line up.
    overview.appendChild(kindIcon('project'));
    overview.appendChild(el('span', 'entry', 'Overview'));
    navEl.appendChild(overview);

    // The root entry is the package; every other row is written as the subpath
    // you actually import (`./vue`, `./router/vapor`). Repeating the package
    // name on all 23 rows spent the widest part of the label on the one word
    // they have in common, and pushed the part that distinguishes them into
    // the truncation. Rows one level deep are indented, which gives the
    // grouping a tree conveys without any collapse state to get wrong.
    var root = pages.length ? pages[0].specifier : '';

    pages.forEach(function (page) {
      var subpath = page.specifier === root ? root : '.' + page.specifier.slice(root.length);
      var depth = (subpath.match(/\//g) || []).length;
      var link = el('a', 'k-module' + (page.name === current ? ' active' : ''));
      if (depth > 1) link.className = (link.className ? link.className + ' ' : '') + 'nested';
      link.href = '#/' + page.name;
      link.appendChild(kindIcon('module'));
      link.appendChild(el('span', 'entry', subpath));
      link.appendChild(el('span', 'count', page.count));
      navEl.appendChild(link);
    });
  }

  var spy = null;

  function buildToc(headings) {
    tocEl.textContent = '';
    var symbols = headings.filter(function (h) {
      return h.level === 3;
    });

    symbols.forEach(function (h) {
      var link = el('a', 'k-' + (h.kind || 'value'));
      link.href = '#/' + currentPage + '#' + h.id;
      link.dataset.target = h.id;
      link.appendChild(kindIcon(h.kind || 'value'));
      link.appendChild(el('span', 'label', h.text));
      tocEl.appendChild(link);
    });

    // Scroll-spy: marks the entry whose heading the reader is currently under.
    //
    // A plain scroll listener, as treegen2's changelog.js does it, rather than
    // an IntersectionObserver. That was not a style preference: the observer
    // version is written against a narrow band under the top bar, and for most
    // scroll positions NO heading is inside that band, so it reported nothing
    // to mark and the list sat with no highlight at all. "The last heading
    // above the line" always has an answer.
    if (spy) window.removeEventListener('scroll', spy);
    if (!symbols.length) return;

    var nodes = symbols
      .map(function (h) {
        return document.getElementById(h.id);
      })
      .filter(Boolean);

    var marked = null;
    spy = function () {
      var current = nodes[0];
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getBoundingClientRect().top > 80) break;
        current = nodes[i];
      }
      if (!current || current.id === marked) return;
      marked = current.id;
      var previous = tocEl.querySelector('a.active');
      if (previous) previous.classList.remove('active');
      var link = tocEl.querySelector('a[data-target="' + marked + '"]');
      if (link) {
        link.classList.add('active');
        keepInView(tocEl, link);
      }
    };

    window.addEventListener('scroll', spy, { passive: true });
    spy();
  }

  function scrollToAnchor(hash) {
    if (!hash) {
      window.scrollTo(0, 0);
      return;
    }
    var target = document.getElementById(hash);
    if (target) target.scrollIntoView();
  }

  function show(name, hash) {
    // Already rendered: clicking a table-of-contents entry is a scroll, not a
    // reload, and re-rendering 75 symbols to move the viewport flickers.
    if (name === currentPage && !docEl.hasAttribute('aria-busy')) {
      scrollToAnchor(hash);
      return;
    }
    currentPage = name;
    docEl.setAttribute('aria-busy', 'true');
    fetchPage(name)
      .then(function (markdown) {
        docEl.textContent = '';
        var headings = render(markdown, docEl);
        docEl.removeAttribute('aria-busy');
        buildNav(name);
        buildToc(headings);
        syncStepper();
        scrollToAnchor(hash);
      })
      .catch(function (error) {
        docEl.textContent = '';
        docEl.appendChild(el('p', 'loading', 'Could not load ' + name + '.md (' + error.message + ').'));
        docEl.removeAttribute('aria-busy');
      });
  }

  // Route is `#/page` with an optional `#anchor` appended after it.
  function route() {
    var raw = location.hash.replace(/^#\/?/, '');
    if (!raw) return show('README', '');
    var cut = raw.indexOf('#');
    var name = cut === -1 ? raw : raw.slice(0, cut);
    var hash = cut === -1 ? '' : raw.slice(cut + 1);
    var known = name === 'README' || pages.some(function (page) {
      return page.name === name;
    });
    show(known ? name : 'README', hash);
  }

  // ---------- sticky offset ----------
  //
  // The two columns pin themselves under the top bar, and the offset has to be
  // the bar's REAL height. A literal drifts the moment anything in the bar
  // changes - a wrapped nav, a hidden search box at narrow widths, a font
  // landing late - and the columns then either slide under the bar on the
  // first scroll or leave a gap above themselves.
  (function trackTopbar() {
    var bar = document.querySelector('.topbar');
    if (!bar) return;
    var apply = function () {
      // getBoundingClientRect, not offsetHeight: the latter rounds to whole
      // pixels, and a bar measuring 53.23px pinned the columns at 53, so they
      // still crept 0.23px under it on the first scroll.
      document.documentElement.style.setProperty('--topbar-h', bar.getBoundingClientRect().height + 'px');
    };
    apply();
    // Both, not one or the other. A ResizeObserver is the precise signal, but
    // it was observed not to fire under emulated viewport changes, which left
    // the offset stale at a two-line bar's height after the nav unwrapped -
    // a 42.77px gap above both columns. The resize listener is cheap and
    // catches exactly that case.
    window.addEventListener('resize', apply);
    if (typeof ResizeObserver === 'function') new ResizeObserver(apply).observe(bar);
    // Late web fonts change the bar's height after first paint.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(apply);
  })();

  // ---------- stepping between entry points ----------
  //
  // The sidebar is 24 rows and a reader working through the surface wants
  // "the next one" far more often than a specific name. Overview counts as
  // position 0 so the sequence covers everything the sidebar lists.

  function order() {
    return ['README'].concat(
      pages.map(function (page) {
        return page.name;
      }),
    );
  }

  function step(delta) {
    var all = order();
    var at = all.indexOf(currentPage);
    if (at === -1) return;
    var next = all[at + delta];
    if (next) location.hash = '#/' + next;
  }

  function syncStepper() {
    var all = order();
    var at = all.indexOf(currentPage);
    var prev = document.getElementById('prev-entry');
    var next = document.getElementById('next-entry');
    if (prev) prev.disabled = at <= 0;
    if (next) next.disabled = at === -1 || at >= all.length - 1;
  }

  (function initStepper() {
    var prev = document.getElementById('prev-entry');
    var next = document.getElementById('next-entry');
    if (prev) prev.addEventListener('click', function () { step(-1); });
    if (next) next.addEventListener('click', function () { step(1); });
  })();

  // ---------- keyboard ----------
  //
  // Only when the reader is not typing, and never with a modifier held, so
  // browser and OS shortcuts keep working. The search modal owns the keyboard
  // while it is open and is handled separately.
  document.addEventListener('keydown', function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    var modal = document.getElementById('search-modal');
    if (modal && !modal.hidden) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;

    if (event.key === 'ArrowLeft' || event.key === '[') {
      event.preventDefault();
      step(-1);
    } else if (event.key === 'ArrowRight' || event.key === ']') {
      event.preventDefault();
      step(1);
    } else if (event.key === 'g') {
      event.preventDefault();
      window.scrollTo(0, 0);
    } else if (event.key === 'G') {
      event.preventDefault();
      window.scrollTo(0, document.body.scrollHeight);
    } else if (event.key === 'j' || event.key === 'k') {
      // Move through the symbols of the current page, following the same list
      // the scroll-spy marks, so the two never disagree.
      event.preventDefault();
      var links = [].slice.call(tocEl.querySelectorAll('a'));
      if (!links.length) return;
      var at = links.indexOf(tocEl.querySelector('a.active'));
      var to = links[Math.min(links.length - 1, Math.max(0, at + (event.key === 'j' ? 1 : -1)))];
      if (to) to.click();
    }
  });

  // ---------- search ----------

  (function initSearch() {
    var trigger = document.getElementById('search-trigger');
    var modal = document.getElementById('search-modal');
    var input = document.getElementById('search-input');
    var results = document.getElementById('search-results');
    if (!trigger || !modal || !input || !results) return;

    var index = null;
    var active = 0;

    // Built once, on first open, by pulling every `### Symbol` heading out of
    // every page. Fetching the whole corpus is what makes the search complete
    // rather than page-local, and it is deferred to first use so a reader who
    // never searches never pays for it.
    function buildIndex() {
      if (index) return Promise.resolve(index);
      return Promise.all(
        pages.map(function (page) {
          return fetchPage(page.name).then(function (markdown) {
            var entries = [];
            var pending = null;
            markdown.split('\n').forEach(function (line) {
              var heading = /^###\s+(.*)$/.exec(line);
              if (heading) {
                var name = heading[1].replace(/`/g, '').trim();
                pending = { symbol: name, page: page.name, where: page.specifier, id: anchor(name), kind: 'value' };
                entries.push(pending);
                return;
              }
              // The kind line follows its heading, so the badge in the results
              // comes from the same Markdown rather than a second index.
              var kind = /^\*\*([A-Za-z ]+)\*\*/.exec(line);
              if (pending && kind && KINDS[kind[1]]) {
                pending.kind = KINDS[kind[1]];
                pending = null;
              }
            });
            return entries;
          });
        }),
      ).then(function (all) {
        // Entry points are searchable too. Without them a query like "vdom" -
        // which is a SUBPATH, not a symbol - returned nothing at all, even
        // though `vapor-chamber/router/vdom` is exactly what was being looked
        // for. They sort first so typing a module name lands on its page.
        var modules = pages.map(function (page) {
          return {
            symbol: page.specifier,
            page: page.name,
            where: 'entry point',
            id: '',
            kind: 'module',
          };
        });
        index = modules.concat(
          all.reduce(function (flat, entries) {
            return flat.concat(entries);
          }, []),
        );
        return index;
      });
    }

    function draw(query) {
      results.textContent = '';
      active = 0;
      if (!index) return;
      var needle = query.trim().toLowerCase();
      var matches = !needle
        ? []
        : index
            .filter(function (entry) {
              return entry.symbol.toLowerCase().indexOf(needle) !== -1;
            })
            // Entry points first, then exact prefixes: both are what someone
            // typing a bare name is most likely reaching for.
            .sort(function (a, b) {
              var am = a.kind === 'module' ? 0 : 1;
              var bm = b.kind === 'module' ? 0 : 1;
              var ap = a.symbol.toLowerCase().indexOf(needle) === 0 ? 0 : 1;
              var bp = b.symbol.toLowerCase().indexOf(needle) === 0 ? 0 : 1;
              return am - bm || ap - bp || a.symbol.length - b.symbol.length;
            })
            .slice(0, 40);

      if (!needle) {
        results.appendChild(el('p', 'empty', index.length + ' symbols indexed. Start typing.'));
        return;
      }
      if (!matches.length) {
        results.appendChild(el('p', 'empty', 'No symbol matches "' + query.trim() + '".'));
        return;
      }
      matches.forEach(function (entry, i) {
        var link = el('a', 'k-' + entry.kind + (i === 0 ? ' active' : ''));
        link.href = '#/' + entry.page + (entry.id ? '#' + entry.id : '');
        link.appendChild(kindIcon(entry.kind));
        link.appendChild(el('span', 'symbol', entry.symbol));
        link.appendChild(el('span', 'where', entry.where));
        link.addEventListener('click', close);
        results.appendChild(link);
      });
    }

    function move(delta) {
      var links = results.querySelectorAll('a');
      if (!links.length) return;
      links[active].classList.remove('active');
      active = (active + delta + links.length) % links.length;
      links[active].classList.add('active');
      keepInView(results, links[active]);
    }

    function open() {
      modal.hidden = false;
      input.value = '';
      results.textContent = '';
      results.appendChild(el('p', 'empty', 'Indexing...'));
      input.focus();
      buildIndex().then(function () {
        draw(input.value);
      });
    }

    function close() {
      modal.hidden = true;
    }

    trigger.addEventListener('click', open);
    input.addEventListener('input', function () {
      draw(input.value);
    });

    input.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        move(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
      } else if (event.key === 'Enter') {
        var current = results.querySelector('a.active');
        if (current) {
          event.preventDefault();
          location.hash = current.getAttribute('href').slice(1);
          close();
        }
      }
    });

    modal.addEventListener('click', function (event) {
      if (event.target === modal) close();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !modal.hidden) {
        close();
        return;
      }
      // "/" is the shortcut, but not while the reader is typing somewhere else.
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (event.key === '/' && modal.hidden && !typing) {
        event.preventDefault();
        open();
      }
    });
  })();

  // ---------- boot ----------

  fetchPage('README')
    .then(function (markdown) {
      pages = parseIndex(markdown);
      window.addEventListener('hashchange', route);
      route();
    })
    .catch(function (error) {
      docEl.textContent = '';
      docEl.appendChild(
        el('p', 'loading', 'Could not load ' + SOURCE + '/README.md (' + error.message + '). Run `npm run docs`.'),
      );
    });
})();
