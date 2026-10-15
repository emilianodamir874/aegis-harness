//! Width-aware terminal layout for complete Markdown table blocks.
//! A model can emit cells longer than the whole screen; never hand such a
//! horizontal table to the terminal's soft-wrap and hope its pipes line up.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

fn width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

fn unescaped_closing_pipe(text: &str) -> bool {
    text.ends_with('|')
        && text[..text.len() - 1]
            .chars()
            .rev()
            .take_while(|c| *c == '\\')
            .count()
            % 2
            == 0
}

fn cells(line: &str) -> Vec<String> {
    let mut line = line.trim();
    if let Some(rest) = line.strip_prefix('|') {
        line = rest;
    }
    if unescaped_closing_pipe(line) {
        line = &line[..line.len() - 1];
    }

    let mut result = Vec::new();
    let mut current = String::new();
    let mut chars = line.chars().peekable();
    let mut in_code = false;
    while let Some(ch) = chars.next() {
        match ch {
            '\\' if chars.peek() == Some(&'|') => {
                chars.next();
                current.push('|');
            }
            '`' => {
                in_code = !in_code;
                current.push(ch);
            }
            '|' if !in_code => {
                result.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    result.push(current.trim().to_string());
    result
}

fn is_divider(cell: &str) -> bool {
    let cell = cell.trim();
    cell.chars().filter(|c| *c == '-').count() >= 3
        && cell.chars().all(|c| matches!(c, '-' | ':' | ' '))
}

fn wrap_words(text: &str, limit: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    let limit = limit.max(1);
    for word in text.split_whitespace() {
        if !line.is_empty() {
            if width(&line) + 1 + width(word) <= limit {
                line.push(' ');
                line.push_str(word);
                continue;
            }
            lines.push(std::mem::take(&mut line));
        }
        for grapheme in word.graphemes(true) {
            if !line.is_empty() && width(&line) + width(grapheme) > limit {
                lines.push(std::mem::take(&mut line));
            }
            line.push_str(grapheme);
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn vertical(rows: &[Vec<String>], columns: usize, limit: usize) -> String {
    let mut lines = Vec::new();
    let budget = limit.saturating_sub(4).max(1);
    for (index, row) in rows.iter().skip(1).enumerate() {
        if index > 0 {
            lines.push(format!("  {}", "─".repeat(budget.min(28))));
        }
        for column in 0..columns {
            let label = rows[0]
                .get(column)
                .filter(|s| !s.is_empty())
                .cloned()
                .unwrap_or_else(|| format!("Column {}", column + 1));
            let value = row.get(column).map(String::as_str).unwrap_or("");
            let prefix = format!("{label}: ");
            let line_budget = budget.saturating_sub(width(&prefix));
            if line_budget >= 6 {
                let wrapped = wrap_words(value, line_budget);
                lines.push(format!("  {prefix}{}", wrapped[0]));
                for continuation in wrapped.iter().skip(1) {
                    lines.push(format!("    {}", continuation));
                }
            } else {
                for label_line in wrap_words(&format!("{label}:"), budget) {
                    lines.push(format!("  {label_line}"));
                }
                for continuation in wrap_words(value, budget.saturating_sub(2)) {
                    if !continuation.is_empty() {
                        lines.push(format!("    {continuation}"));
                    }
                }
            }
        }
    }
    lines.join("\n")
}

/// Format a complete table, choosing horizontal columns only if its longest
/// visible row fits inside the terminal with a two-cell resize margin.
/// `clean` removes inline Markdown before measuring and padding display cells.
pub(super) fn format_table(
    table_lines: &[&str],
    terminal_width: usize,
    clean: impl Fn(&str) -> String,
) -> Option<String> {
    if table_lines.len() < 2 {
        return None;
    }
    let header = cells(table_lines[0]);
    let divider = cells(table_lines[1]);
    if header.len() < 2 || divider.len() != header.len() || !divider.iter().all(|c| is_divider(c)) {
        return None;
    }
    let mut rows = vec![header];
    for line in table_lines.iter().skip(2) {
        rows.push(cells(line));
    }
    let columns = rows.iter().map(Vec::len).max()?;
    for row in &mut rows {
        row.resize(columns, String::new());
        for cell in row {
            *cell = clean(cell);
        }
    }

    let widths: Vec<usize> = (0..columns)
        .map(|column| {
            rows.iter()
                .map(|row| width(&row[column]))
                .max()
                .unwrap_or(0)
                .max(3)
        })
        .collect();
    let required = widths.iter().sum::<usize>() + 3 * columns + 1;
    let budget = terminal_width.saturating_sub(2).max(1);
    if required > budget && rows.len() > 1 {
        return Some(vertical(&rows, columns, budget));
    }

    let mut result = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let padded = row
            .iter()
            .enumerate()
            .map(|(column, cell)| {
                format!(
                    "{cell}{}",
                    " ".repeat(widths[column].saturating_sub(width(cell)))
                )
            })
            .collect::<Vec<_>>();
        result.push(format!("| {} |", padded.join(" | ")));
        if index == 0 {
            result.push(format!(
                "|{}|",
                widths
                    .iter()
                    .map(|width| "-".repeat(width + 2))
                    .collect::<Vec<_>>()
                    .join("|")
            ));
        }
    }
    Some(result.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unchanged(text: &str) -> String {
        text.to_string()
    }

    #[test]
    fn short_table_stays_horizontal_and_unicode_pipes_align() {
        let table = format_table(
            &[
                "| Proyecto | Estado |",
                "| --- | --- |",
                "| 🦀 Rust | bien |",
                "| 漢字 | ok |",
            ],
            80,
            unchanged,
        )
        .unwrap();
        let rows: Vec<&str> = table.lines().collect();
        assert_eq!(rows.len(), 4);
        assert!(rows.iter().all(|row| width(row) == width(rows[0])));
        assert!(table.contains("🦀 Rust"));
    }

    #[test]
    fn same_table_reflows_when_terminal_width_changes() {
        let rows = [
            "| Proyecto | Estado |",
            "| --- | --- |",
            "| Servo | en marcha |",
        ];
        let wide = format_table(&rows, 80, unchanged).unwrap();
        let narrow = format_table(&rows, 22, unchanged).unwrap();
        assert!(wide.contains("| Servo"));
        assert!(narrow.contains("Proyecto: Servo"));
        assert!(narrow.lines().all(|line| width(line) <= 20));
    }

    #[test]
    fn long_table_becomes_readable_blocks_without_losing_values() {
        let table = format_table(&[
            "| Proyecto | Estado | Qué es |",
            "| --- | --- | --- |",
            "| Servo | activo | Un navegador experimental escrito en Rust que requiere una plataforma moderna |",
            "| Gosub | beta | Motor alternativo con varias piezas |",
        ], 42, unchanged).unwrap();
        assert!(table.contains("Proyecto: Servo"));
        assert!(table.contains("Estado: activo"));
        assert!(table.contains("plataforma moderna"));
        assert!(table.contains("Proyecto: Gosub"));
        assert!(table.lines().all(|line| width(line) <= 40), "{table}");
        assert!(!table.contains("| ---"));
    }

    #[test]
    fn escaped_and_code_pipes_are_cell_content() {
        let table = format_table(
            &["| Regla | Nota |", "| --- | --- |", "| `a|b` | x\\|y |"],
            20,
            |cell| cell.replace('`', ""),
        )
        .unwrap();
        assert!(table.contains("a|b"));
        assert!(table.contains("x|y"));
        assert!(!table.contains("Column 3"));
    }

    #[test]
    fn unicode_and_unbroken_words_are_wrapped_not_truncated() {
        let word = "界".repeat(35);
        let table = format_table(
            &[
                "| Clave | Valor |",
                "| --- | --- |",
                &format!("| emoji | {word} |"),
            ],
            25,
            unchanged,
        )
        .unwrap();
        assert_eq!(table.matches('界').count(), 35);
        assert!(table.lines().all(|line| width(line) <= 23), "{table}");
    }

    #[test]
    fn malformed_divider_is_not_eaten() {
        assert!(format_table(&["| a | b |", "| wrong | divider |"], 80, unchanged).is_none());
    }
}
