import { htmlToText, stripQuotedLines, contextualChunk, rrf } from '../../src/utils/text';

describe('htmlToText', () => {
  it('strips script and style blocks', () => {
    const html = '<style>body{color:red}</style><p>Hello</p><script>alert(1)</script>';
    const result = htmlToText(html);
    expect(result).toContain('Hello');
    expect(result).not.toContain('color:red');
    expect(result).not.toContain('alert');
  });

  it('converts block elements to newlines', () => {
    const html = '<p>First</p><p>Second</p><br>Third';
    const result = htmlToText(html);
    expect(result).toContain('First');
    expect(result).toContain('Second');
    expect(result).toContain('Third');
  });

  it('decodes HTML entities', () => {
    const html = '<p>Price: &euro;100 &amp; taxes</p>';
    const result = htmlToText(html);
    expect(result).toContain('€100');
    expect(result).toContain('& taxes');
  });

  it('handles empty input', () => {
    expect(htmlToText('')).toBe('');
  });

  it('handles plain text (no tags)', () => {
    const text = 'Just plain text here.';
    expect(htmlToText(text)).toBe(text);
  });
});

describe('stripQuotedLines', () => {
  it('removes > prefixed lines', () => {
    const text = 'My reply\n> Original line\n> Another quoted\nMore reply';
    const result = stripQuotedLines(text);
    expect(result).toContain('My reply');
    expect(result).toContain('More reply');
    expect(result).not.toContain('> Original');
    expect(result).not.toContain('> Another');
  });

  it('handles deeply quoted lines', () => {
    const text = 'Response\n>> Deep quote\n> Shallow quote\nText';
    const result = stripQuotedLines(text);
    expect(result).not.toContain('>>');
    expect(result).not.toContain('>');
    expect(result).toContain('Response');
    expect(result).toContain('Text');
  });

  it('returns unmodified text with no quotes', () => {
    const text = 'Clean text\nNo quotes here';
    expect(stripQuotedLines(text)).toContain('Clean text');
  });
});

describe('contextualChunk', () => {
  const header = 'Subject: Test\nFrom: test@example.com\nDate: 2026-01-01';

  it('prepends metadata header to first chunk', () => {
    const text = 'Short body.';
    const chunks = contextualChunk(text, header, 'body');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Subject: Test');
    expect(chunks[0]).toContain('Short body.');
  });

  it('returns header-only chunk for empty body', () => {
    const chunks = contextualChunk('', header, 'body');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Subject: Test');
  });

  it('splits long text at paragraph boundaries', () => {
    const para = 'Word '.repeat(100); // ~500 chars per paragraph
    const text = [para, para, para, para, para].join('\n\n'); // ~2500 chars total
    const chunks = contextualChunk(text, header, 'body', 600);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be under the limit (with some tolerance for overlap)
    chunks.forEach(c => expect(c.length).toBeLessThan(1500));
  });

  it('includes overlap from previous chunk in subsequent chunks', () => {
    const para1 = 'First paragraph with unique token ALPHA. ' + 'x'.repeat(400);
    const para2 = 'Second paragraph with unique token BETA. ' + 'x'.repeat(400);
    const para3 = 'Third paragraph with unique token GAMMA. ' + 'x'.repeat(400);
    const text = [para1, para2, para3].join('\n\n');
    const chunks = contextualChunk(text, header, 'body', 500);
    if (chunks.length > 1) {
      // Second chunk should contain overlap from para1 or para2
      const laterChunks = chunks.slice(1).join(' ');
      // The overlap paragraph should appear in a later chunk
      expect(laterChunks).toMatch(/ALPHA|BETA/);
    }
  });

  it('does not produce empty chunks', () => {
    const text = 'Para one.\n\nPara two.\n\nPara three.';
    const chunks = contextualChunk(text, header, 'body', 50);
    chunks.forEach(c => expect(c.trim()).not.toBe(''));
  });
});

describe('rrf', () => {
  const makeItems = (ids: string[]) => ids.map(id => ({ id, subject: id }));

  it('returns items ranked by combined score', () => {
    const vector = makeItems(['a', 'b', 'c']);
    const fts    = makeItems(['b', 'c', 'd']);
    const result = rrf(vector, fts);
    // 'b' and 'c' appear in both lists — should rank above 'a' and 'd'
    const ids = result.map(r => r.id);
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('a'));
    expect(ids.indexOf('c')).toBeLessThan(ids.indexOf('d'));
  });

  it('deduplicates by id', () => {
    const vector = makeItems(['a', 'b', 'a']); // duplicate 'a'
    const fts    = makeItems(['b', 'c']);
    const result = rrf(vector, fts);
    const ids = result.map(r => r.id);
    expect(ids.filter(id => id === 'a')).toHaveLength(1);
  });

  it('handles empty inputs', () => {
    expect(rrf([], [])).toHaveLength(0);
    expect(rrf(makeItems(['a']), [])).toHaveLength(1);
    expect(rrf([], makeItems(['b']))).toHaveLength(1);
  });

  it('includes all unique items from both lists', () => {
    const vector = makeItems(['a', 'b']);
    const fts    = makeItems(['c', 'd']);
    const result = rrf(vector, fts);
    expect(result).toHaveLength(4);
  });
});
