// Fast drop-in for make.fun's csv-reader 1.0.0: run(input) returns exactly csv-reader's
// answer {columns, rows, errors} for {text, header}, but reads the text with native
// scans (indexOf / one regex exec per field / one split per clean record) instead of
// one character at a time.
//
// The reading policy is csv-reader's own, kept exactly:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside
//     it one quote, and each CRLF or lone CR inside it is read as LF; what follows its
//     closing quote, up to the next comma or line break, is appended to it as it stands
//     (quote_junk, when the field ends); a quote that never closes is a literal character,
//     and the text after it is read again as an unquoted field (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings;
//   - columns is the first record when header is true, else null; rows holds the records
//     after it, each padded with "" (short_row, with fields: its count) or cut (long_row,
//     with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every
//     LF, CRLF and lone CR inside a quoted field counted), row its record's index in rows
//     (null for the header), in the order met.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

/** How a field ended: at a comma (the record goes on), at a line break or at the end. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The next quote, CR or LF inside a quoted field, at or after the scan position. */
const QSPECIAL = /["\r\n]/g;

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and how many characters were kept onto it
  // (readQuoted's junk path needs the kept count). Written by readUnquoted/readQuoted, read
  // by their caller; no object is built per field.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters onto `value` up to the next comma or line break. A CR in the
  // chunk is a stray_cr and is dropped, except a CR right before the line break, which is
  // the CRLF ending. Sets fValue, fEnded, fAdded.
  function readUnquoted(value) {
    let added = 0;
    const ci = text.indexOf(',', pos);
    const ni = text.indexOf('\n', pos);
    let end;
    let ended;
    if (ci === -1) {
      if (ni === -1) {
        end = n;
        ended = END;
      } else {
        end = ni;
        ended = LINE_BREAK;
      }
    } else if (ni === -1 || ci < ni) {
      end = ci;
      ended = COMMA;
    } else {
      end = ni;
      ended = LINE_BREAK;
    }
    if (end > pos) {
      const chunk = text.slice(pos, end);
      const ri = chunk.indexOf('\r');
      if (ri === -1) {
        value += chunk;
        added += end - pos;
      } else {
        // A trailing CR before a line break is the CRLF ending, not a stray CR.
        let scanEnd = chunk.length;
        if (ended === LINE_BREAK && chunk.charCodeAt(chunk.length - 1) === 13) scanEnd -= 1;
        let s = 0;
        for (let k = 0; k < scanEnd; k++) {
          if (chunk.charCodeAt(k) === 13) {
            if (k > s) {
              value += chunk.slice(s, k);
              added += k - s;
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            s = k + 1;
          }
        }
        if (s < scanEnd) {
          value += chunk.slice(s, scanEnd);
          added += scanEnd - s;
        }
      }
    }
    if (ended === COMMA) pos = end + 1;
    else if (ended === LINE_BREAK) {
      pos = end + 1;
      line += 1;
    } else pos = n;
    fValue = value;
    fEnded = ended;
    fAdded = added;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue, fEnded, fAdded.
  // One regex scan finds the next quote, CR or LF inside the quotes: a doubled quote is
  // one quote, and each CRLF or lone CR is read as one LF (and counts one line).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let start = pos + 1;
    for (;;) {
      QSPECIAL.lastIndex = start;
      const m = QSPECIAL.exec(text);
      if (m === null) {
        // The quote never closes: it is a literal character, and the text after it is read
        // again as an unquoted field.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      const i = m.index;
      const c = m[0];
      if (c === '"') {
        if (text.charCodeAt(i + 1) === 34) {
          value += text.slice(start, i) + '"';
          start = i + 2;
          continue;
        }
        value += text.slice(start, i);
        pos = i + 1;
        if (pos >= n) {
          fValue = value;
          fEnded = END;
          fAdded = 0;
          return;
        }
        const d = text[pos];
        if (d === ',') {
          pos += 1;
          fValue = value;
          fEnded = COMMA;
          fAdded = 0;
          return;
        }
        if (d === '\n') {
          pos += 1;
          line += 1;
          fValue = value;
          fEnded = LINE_BREAK;
          fAdded = 0;
          return;
        }
        if (d === '\r' && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          fValue = value;
          fEnded = LINE_BREAK;
          fAdded = 0;
          return;
        }
        // What follows the closing quote is appended as it stands, up to the next comma or
        // line break.
        readUnquoted(value);
        if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        return;
      }
      // A CR or LF inside quotes is read as one LF.
      value += text.slice(start, i) + '\n';
      line += 1;
      start = c === '\r' && text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
    }
  }

  // Finishes a record: the header, or a padded/cut row with its short_row/long_row error.
  // Returns false when the record is no record at all (a line left with no characters).
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return false;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return true;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
    return true;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record holds no quote and no stray CR before its line break, so it is
    // one slice split on commas. A CR right before the LF is the CRLF ending and is cut off.
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? n : nl;
    let segEnd = end;
    if (nl !== -1 && end > pos && text.charCodeAt(end - 1) === 13) segEnd = end - 1;
    const seg = text.slice(pos, segEnd);
    if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
      const fields = seg.split(',');
      pos = nl === -1 ? n : nl + 1;
      if (nl !== -1) line += 1;
      finishRecord(fields, false);
      continue;
    }

    // Slow path: the record holds a quote, a stray CR, or both; read it field by field.
    const fields = [];
    let quoted;
    do {
      quoted = text[pos] === '"';
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA);
    finishRecord(fields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
