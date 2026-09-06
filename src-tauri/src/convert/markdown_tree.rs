use pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd};
use rusqlite::{params, Connection};
use saphyr::LoadableYamlNode;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const CREATE_NOTES_TABLE_SQL: &str = "
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    label TEXT NOT NULL,
    is_expanded INTEGER,
    sort_order INTEGER NOT NULL,
    content TEXT
);
CREATE INDEX IF NOT EXISTS notes_parent_id_idx ON notes(parent_id);";

#[derive(Debug, Serialize, Clone)]
pub struct ImportSummary {
    pub notes_imported: usize,
    pub dest_path: String,
}

#[derive(Debug, Clone)]
pub struct MarkdownImportOptions {
    pub skip_directory_names: &'static [&'static str],
    pub title_from_front_matter: bool,
    pub convert_obsidian_wikilinks: bool,
}

#[derive(Debug, Clone)]
struct CollectedNode {
    label: String,
    sort_name: String,
    path: PathBuf,
    content: String,
    children: Vec<CollectedNode>,
}

#[derive(Debug, Clone)]
struct FlatNoteRow {
    id: String,
    parent_id: Option<String>,
    label: String,
    sort_order: i64,
    content: String,
}

pub fn import_markdown_tree(
    source_path: &Path,
    dest_path: &Path,
    current_database_path: &str,
    options: &MarkdownImportOptions,
    empty_import_error: &str,
) -> Result<ImportSummary, String> {
    if dest_path.exists() {
        return Err(format!(
            "A file already exists at {}. Choose a different location.",
            dest_path.display()
        ));
    }
    if paths_equal(dest_path, Path::new(current_database_path)) {
        return Err(
            "Cannot import into the currently open notebook. Choose a different file.".into(),
        );
    }

    let roots = collect_children(source_path, options)?;
    if roots.is_empty() {
        return Err(empty_import_error.into());
    }

    let mut flat_rows = Vec::new();
    for (index, root) in roots.into_iter().enumerate() {
        flatten_node(&root, None, index as i64, &mut flat_rows);
    }

    if flat_rows.is_empty() {
        return Err(empty_import_error.into());
    }

    let parent = dest_path
        .parent()
        .ok_or_else(|| "Invalid destination path.".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let temp_path = parent.join(format!(".treenote-md-import-{}.partial", Uuid::new_v4()));

    let import_result = write_treenote_notebook(&temp_path, &flat_rows);
    if let Err(error) = import_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    fs::rename(&temp_path, dest_path).map_err(|e| {
        let _ = fs::remove_file(&temp_path);
        format!("Failed to create notebook: {}", e)
    })?;

    Ok(ImportSummary {
        notes_imported: flat_rows.len(),
        dest_path: dest_path.to_string_lossy().to_string(),
    })
}

pub(crate) fn validate_import_directory(
    source_path: &Path,
    not_found_message: &str,
    not_directory_message: &str,
    symlink_message: &str,
) -> Result<(), String> {
    let meta = fs::symlink_metadata(source_path)
        .map_err(|_| format!("{not_found_message}: {}", source_path.display()))?;
    if meta.file_type().is_symlink() {
        return Err(symlink_message.into());
    }
    if !meta.is_dir() {
        return Err(format!(
            "{not_directory_message}: {}",
            source_path.display()
        ));
    }
    Ok(())
}

fn collect_children(
    dir: &Path,
    options: &MarkdownImportOptions,
) -> Result<Vec<CollectedNode>, String> {
    let mut nodes = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let name = entry.file_name();

        if file_type.is_file() {
            if is_markdown_file(&name) {
                nodes.push(read_markdown_node(&path, &name, options)?);
            }
        } else if file_type.is_dir() {
            if should_skip_directory(&name, options) {
                continue;
            }
            if let Some(folder) = collect_folder_node(&path, &name, options)? {
                nodes.push(folder);
            }
        }
    }

    nodes.sort_by(|a, b| {
        a.label
            .cmp(&b.label)
            .then(a.sort_name.cmp(&b.sort_name))
            .then(a.path.cmp(&b.path))
    });
    Ok(nodes)
}

fn collect_folder_node(
    path: &Path,
    name: &std::ffi::OsStr,
    options: &MarkdownImportOptions,
) -> Result<Option<CollectedNode>, String> {
    let children = collect_children(path, options)?;
    if children.is_empty() {
        return Ok(None);
    }
    Ok(Some(CollectedNode {
        label: label_from_name(&name.to_string_lossy()),
        sort_name: name.to_string_lossy().into_owned(),
        path: path.to_path_buf(),
        content: String::new(),
        children,
    }))
}

fn read_markdown_node(
    path: &Path,
    name: &std::ffi::OsStr,
    options: &MarkdownImportOptions,
) -> Result<CollectedNode, String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("Could not read Markdown file {}: {}", path.display(), e))?;
    let (front_matter, body) = split_front_matter(&raw);
    let stem = markdown_stem(name);
    let label = if options.title_from_front_matter {
        front_matter
            .and_then(joplin_title_from_yaml)
            .unwrap_or_else(|| label_from_name(&stem))
    } else {
        label_from_name(&stem)
    };
    let content = markdown_to_plain_text(body, options.convert_obsidian_wikilinks);
    Ok(CollectedNode {
        label,
        sort_name: name.to_string_lossy().into_owned(),
        path: path.to_path_buf(),
        content,
        children: Vec::new(),
    })
}

fn flatten_node(
    node: &CollectedNode,
    parent_id: Option<String>,
    sort_order: i64,
    out: &mut Vec<FlatNoteRow>,
) {
    let id = Uuid::new_v4().to_string();
    out.push(FlatNoteRow {
        id: id.clone(),
        parent_id,
        label: node.label.clone(),
        sort_order,
        content: node.content.clone(),
    });
    for (index, child) in node.children.iter().enumerate() {
        flatten_node(child, Some(id.clone()), index as i64, out);
    }
}

fn should_skip_directory(name: &std::ffi::OsStr, options: &MarkdownImportOptions) -> bool {
    let name = name.to_string_lossy();
    options
        .skip_directory_names
        .iter()
        .any(|skip| name.eq_ignore_ascii_case(skip))
}

fn is_markdown_file(name: &std::ffi::OsStr) -> bool {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

fn markdown_stem(name: &std::ffi::OsStr) -> String {
    Path::new(name)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string_lossy().into_owned())
}

fn label_from_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

fn strip_bom(content: &str) -> &str {
    content.strip_prefix('\u{feff}').unwrap_or(content)
}

fn trim_line_terminator(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

pub(crate) fn split_front_matter(content: &str) -> (Option<&str>, &str) {
    let content = strip_bom(content);
    if !content.starts_with("---") {
        return (None, content);
    }
    let after_open = &content[3..];
    let body_start = if after_open.starts_with("\r\n") {
        3 + 2
    } else if after_open.starts_with('\n') {
        3 + 1
    } else {
        return (None, content);
    };

    let rest = &content[body_start..];
    let mut line_start = 0usize;
    while line_start < rest.len() {
        let line_end = rest[line_start..]
            .find('\n')
            .map(|index| line_start + index)
            .unwrap_or(rest.len());
        let line = &rest[line_start..line_end];
        if trim_line_terminator(line) == "---" {
            let yaml = rest[..line_start].trim();
            let markdown_start = if line_end < rest.len() {
                line_end + 1
            } else {
                line_end
            };
            let markdown = &rest[markdown_start..];
            let yaml_opt = if yaml.is_empty() { None } else { Some(yaml) };
            return (yaml_opt, markdown);
        }
        if line_end >= rest.len() {
            break;
        }
        line_start = line_end + 1;
    }
    (None, content)
}

fn joplin_title_from_yaml(yaml_text: &str) -> Option<String> {
    use saphyr::Yaml;
    let docs = Yaml::load_from_str(yaml_text).ok()?;
    let doc = docs.first()?;
    let title = doc.as_mapping_get("title")?;
    if !title.is_string() {
        return None;
    }
    let value = title.as_str()?.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

pub(crate) fn markdown_to_plain_text(markdown: &str, convert_obsidian_wikilinks: bool) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_TASKLISTS);
    if convert_obsidian_wikilinks {
        options.insert(Options::ENABLE_WIKILINKS);
    }

    let parser = Parser::new_ext(markdown, options);
    let mut flattener = MdFlattener::new(convert_obsidian_wikilinks);
    for event in parser {
        flattener.handle_event(event);
    }
    flattener.finish()
}

struct MdFlattener {
    out: String,
    convert_wikilinks: bool,
    in_code_block: bool,
    list_depth: usize,
    at_line_start: bool,
    pending_blank_line: bool,
    skip_wiki_media_embed: bool,
}

impl MdFlattener {
    fn new(convert_wikilinks: bool) -> Self {
        Self {
            out: String::new(),
            convert_wikilinks,
            in_code_block: false,
            list_depth: 0,
            at_line_start: true,
            pending_blank_line: false,
            skip_wiki_media_embed: false,
        }
    }

    fn finish(mut self) -> String {
        self.trim_trailing_whitespace();
        self.out
    }

    fn trim_trailing_whitespace(&mut self) {
        while self.out.ends_with('\n') {
            self.out.pop();
        }
    }

    fn ensure_blank_line(&mut self) {
        if self.out.is_empty() {
            return;
        }
        if !self.out.ends_with("\n\n") {
            if self.out.ends_with('\n') {
                self.out.push('\n');
            } else {
                self.out.push_str("\n\n");
            }
        }
        self.at_line_start = true;
    }

    fn write_newline(&mut self) {
        if self.out.is_empty() || self.out.ends_with('\n') {
            self.out.push('\n');
        } else {
            self.out.push('\n');
        }
        self.at_line_start = true;
    }

    fn write_indent(&mut self) {
        if self.at_line_start && self.list_depth > 0 {
            for _ in 0..self.list_depth {
                self.out.push_str("  ");
            }
            self.at_line_start = false;
        }
    }

    fn push_text(&mut self, text: &str) {
        if text.is_empty() || self.skip_wiki_media_embed {
            return;
        }
        self.write_indent();
        self.out.push_str(text);
        self.at_line_start = false;
        self.pending_blank_line = false;
    }

    fn handle_event(&mut self, event: Event<'_>) {
        match event {
            Event::Text(text) => {
                let chunk = if self.in_code_block || !self.convert_wikilinks {
                    text.into_string()
                } else {
                    rewrite_wikilinks_in_text(&text)
                };
                self.push_text(&chunk);
            }
            Event::Code(code) => {
                self.push_text(&code);
            }
            Event::Start(Tag::CodeBlock(_)) => {
                if !self.out.is_empty() && !self.out.ends_with('\n') {
                    self.write_newline();
                }
                self.in_code_block = true;
                self.at_line_start = true;
            }
            Event::End(TagEnd::CodeBlock) => {
                self.in_code_block = false;
                self.write_newline();
            }
            Event::Start(Tag::Paragraph) => {
                if self.pending_blank_line {
                    self.ensure_blank_line();
                    self.pending_blank_line = false;
                }
            }
            Event::End(TagEnd::Paragraph) => {
                self.pending_blank_line = true;
            }
            Event::Start(Tag::Heading { .. }) => {}
            Event::End(TagEnd::Heading(..)) => {
                self.ensure_blank_line();
            }
            Event::SoftBreak | Event::HardBreak => {
                self.write_newline();
            }
            Event::Rule => {}
            Event::Start(Tag::List(_)) => {
                self.list_depth += 1;
            }
            Event::End(TagEnd::List(_)) => {
                if self.list_depth > 0 {
                    self.list_depth -= 1;
                }
                self.write_newline();
            }
            Event::Start(Tag::Item) => {
                self.write_newline();
            }
            Event::End(TagEnd::Item) => {}
            Event::Start(Tag::BlockQuote(_)) => {}
            Event::End(TagEnd::BlockQuote(_)) => {
                self.write_newline();
            }
            Event::Start(Tag::Table(_)) => {}
            Event::End(TagEnd::Table) => {
                self.write_newline();
            }
            Event::Start(Tag::TableHead) | Event::Start(Tag::TableRow) => {}
            Event::End(TagEnd::TableHead) | Event::End(TagEnd::TableRow) => {
                self.write_newline();
            }
            Event::Start(Tag::TableCell) => {}
            Event::End(TagEnd::TableCell) => {
                self.out.push('\t');
            }
            Event::Start(Tag::Image {
                link_type: LinkType::WikiLink { .. },
                dest_url,
                ..
            }) => {
                if self.convert_wikilinks && !self.in_code_block && is_media_wiki_target(&dest_url)
                {
                    self.skip_wiki_media_embed = true;
                }
            }
            Event::End(TagEnd::Image) => {
                self.skip_wiki_media_embed = false;
            }
            Event::Html(html) => {
                let stripped = strip_html_tags(&html);
                if !stripped.is_empty() {
                    self.push_text(&stripped);
                }
            }
            Event::InlineHtml(_) => {}
            Event::FootnoteReference(_) => {}
            Event::Start(Tag::FootnoteDefinition(_)) => {}
            Event::End(TagEnd::FootnoteDefinition) => {}
            Event::Start(Tag::DefinitionList)
            | Event::Start(Tag::DefinitionListTitle)
            | Event::Start(Tag::DefinitionListDefinition) => {}
            Event::End(TagEnd::DefinitionList)
            | Event::End(TagEnd::DefinitionListTitle)
            | Event::End(TagEnd::DefinitionListDefinition) => {}
            Event::Start(Tag::HtmlBlock) => {}
            Event::End(TagEnd::HtmlBlock) => {
                self.write_newline();
            }
            Event::Start(Tag::Emphasis)
            | Event::Start(Tag::Strong)
            | Event::Start(Tag::Strikethrough) => {}
            Event::End(TagEnd::Emphasis)
            | Event::End(TagEnd::Strong)
            | Event::End(TagEnd::Strikethrough) => {}
            Event::InlineMath(_) | Event::DisplayMath(_) => {}
            Event::TaskListMarker(_) => {}
            _ => {}
        }
    }
}

fn strip_html_tags(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in html.chars() {
        if ch == '<' {
            in_tag = true;
        } else if ch == '>' {
            in_tag = false;
        } else if !in_tag {
            out.push(ch);
        }
    }
    out.trim().to_string()
}

fn rewrite_wikilinks_in_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if i + 2 < chars.len() && chars[i] == '!' && chars[i + 1] == '[' && chars[i + 2] == '[' {
            if let Some((end, inner)) = parse_wiki_inner_owned(&chars, i + 3) {
                if !is_media_wiki_target(&inner) {
                    out.push_str(&wiki_inner_to_display(&inner));
                }
                i = end;
                continue;
            }
        } else if i + 1 < chars.len() && chars[i] == '[' && chars[i + 1] == '[' {
            if let Some((end, inner)) = parse_wiki_inner_owned(&chars, i + 2) {
                out.push_str(&wiki_inner_to_display(&inner));
                i = end;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn parse_wiki_inner_owned(chars: &[char], start: usize) -> Option<(usize, String)> {
    let mut i = start;
    while i + 1 < chars.len() {
        if chars[i] == ']' && chars[i + 1] == ']' {
            let inner: String = chars[start..i].iter().collect();
            return Some((i + 2, inner));
        }
        i += 1;
    }
    None
}

fn wiki_inner_to_display(inner: &str) -> String {
    if let Some(pos) = inner.rfind('|') {
        inner[pos + 1..].to_string()
    } else {
        inner.to_string()
    }
}

fn is_media_wiki_target(inner: &str) -> bool {
    let target = inner.split('|').next().unwrap_or(inner);
    let target = target.split('#').next().unwrap_or(target).trim();
    let lower = target.to_lowercase();
    const MEDIA_EXTENSIONS: &[&str] = &[
        "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "mp3", "mp4", "webm", "wav",
        "pdf", "avi", "mov", "mkv", "flac", "ogg", "m4a", "exe", "zip",
    ];
    MEDIA_EXTENSIONS
        .iter()
        .any(|ext| lower.ends_with(&format!(".{ext}")))
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn write_treenote_notebook(dest_path: &Path, rows: &[FlatNoteRow]) -> Result<(), String> {
    let conn = Connection::open(dest_path).map_err(|e| e.to_string())?;
    conn.execute_batch(CREATE_NOTES_TABLE_SQL)
        .map_err(|e| e.to_string())?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for row in rows {
        tx.execute(
            "INSERT INTO notes (id, parent_id, label, is_expanded, sort_order, content) \
             VALUES (?1, ?2, ?3, 1, ?4, ?5)",
            params![
                row.id,
                row.parent_id,
                row.label,
                row.sort_order,
                row.content
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("treenote-md-test-{name}-{nanos}"));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn temp_db(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!("treenote-md-test-{name}-{nanos}.sqlite3"))
    }

    fn default_options() -> MarkdownImportOptions {
        MarkdownImportOptions {
            skip_directory_names: &[],
            title_from_front_matter: false,
            convert_obsidian_wikilinks: true,
        }
    }

    fn read_treenote_rows(path: &Path) -> Vec<(Option<String>, String, i64, String)> {
        let conn = Connection::open(path).expect("open");
        let mut stmt = conn
            .prepare(
                "SELECT parent_id, label, sort_order, content FROM notes \
                 ORDER BY COALESCE(parent_id, ''), sort_order, label",
            )
            .expect("prepare");
        stmt.query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .expect("query")
        .filter_map(Result::ok)
        .collect()
    }

    fn import_fixture(
        fixture: &Path,
        dest: &Path,
        options: &MarkdownImportOptions,
    ) -> ImportSummary {
        import_markdown_tree(
            fixture,
            dest,
            "C:/other/current.sqlite3",
            options,
            "No importable notes were found.",
        )
        .expect("import")
    }

    #[test]
    fn nested_folders_without_synthetic_root() {
        let root = temp_dir("nested");
        fs::create_dir_all(root.join("Projects")).expect("mkdir");
        fs::write(root.join("Welcome.md"), "hello").expect("write");
        fs::write(root.join("Projects/Alpha.md"), "alpha").expect("write");
        let dest = temp_db("nested-out");
        let summary = import_fixture(&root, &dest, &default_options());
        assert_eq!(summary.notes_imported, 3);
        let rows = read_treenote_rows(&dest);
        assert_eq!(rows.len(), 3);
        let roots = rows.iter().filter(|(p, _, _, _)| p.is_none()).count();
        assert_eq!(roots, 2);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn sibling_order_is_name_based() {
        let root = temp_dir("order");
        fs::write(root.join("b.md"), "b").expect("write");
        fs::write(root.join("a.md"), "a").expect("write");
        let dest = temp_db("order-out");
        import_fixture(&root, &dest, &default_options());
        let rows = read_treenote_rows(&dest);
        let labels: Vec<_> = rows.iter().map(|(_, l, _, _)| l.as_str()).collect();
        assert_eq!(labels, vec!["a", "b"]);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn ignores_non_markdown_files() {
        let root = temp_dir("ignore");
        fs::write(root.join("readme.txt"), "x").expect("write");
        fs::write(root.join("note.md"), "ok").expect("write");
        let dest = temp_db("ignore-out");
        let summary = import_fixture(&root, &dest, &default_options());
        assert_eq!(summary.notes_imported, 1);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn unicode_non_markdown_filename_does_not_panic() {
        let name = std::ffi::OsStr::new("\u{03B1}.txt");
        assert!(!is_markdown_file(name));
        let _stem = markdown_stem(name);
    }

    #[test]
    fn empty_resource_directory_produces_no_node() {
        let root = temp_dir("empty-res");
        fs::create_dir_all(root.join("_resources")).expect("mkdir");
        fs::write(root.join("_resources/photo.png"), "bin").expect("write");
        let dest = temp_db("empty-res-out");
        let err = import_markdown_tree(
            &root,
            &dest,
            "C:/other/current.sqlite3",
            &default_options(),
            "empty",
        )
        .expect_err("empty");
        assert_eq!(err, "empty");
        assert!(!dest.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parent_md_and_parent_dir_are_distinct_siblings() {
        let root = temp_dir("distinct");
        fs::write(root.join("Parent.md"), "parent body").expect("write");
        fs::create_dir_all(root.join("Parent")).expect("mkdir");
        fs::write(root.join("Parent/Child.md"), "child").expect("write");
        let dest = temp_db("distinct-out");
        import_fixture(&root, &dest, &default_options());
        let rows = read_treenote_rows(&dest);
        let roots: Vec<_> = rows
            .iter()
            .filter(|(p, _, _, _)| p.is_none())
            .map(|(_, l, _, c)| (l.as_str(), c.as_str()))
            .collect();
        assert_eq!(roots.len(), 2);
        assert!(roots
            .iter()
            .any(|(l, c)| *l == "Parent" && *c == "parent body"));
        assert!(roots.iter().any(|(l, c)| *l == "Parent" && c.is_empty()));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn folder_without_md_file_has_empty_body_and_children() {
        let root = temp_dir("folder-only");
        fs::create_dir_all(root.join("Parent/Child")).expect("mkdir");
        fs::write(root.join("Parent/Child/leaf.md"), "leaf").expect("write");
        let dest = temp_db("folder-only-out");
        import_fixture(&root, &dest, &default_options());
        let rows = read_treenote_rows(&dest);
        assert!(rows
            .iter()
            .any(|(p, l, _, c)| p.is_none() && l == "Parent" && c.is_empty()));
        assert!(rows.iter().any(|(_, l, _, _)| l == "Child"));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn md_without_folder_is_leaf() {
        let root = temp_dir("leaf");
        fs::write(root.join("Only.md"), "solo").expect("write");
        let dest = temp_db("leaf-out");
        import_fixture(&root, &dest, &default_options());
        let rows = read_treenote_rows(&dest);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].3, "solo");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn rejects_symlink_root() {
        let root = temp_dir("symlink-root");
        fs::create_dir(root.join("real")).expect("mkdir");
        fs::write(root.join("real/note.md"), "x").expect("write");
        let link = root.join("link");
        let _link = link;
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            if symlink(root.join("real"), &link).is_ok() {
                let err =
                    validate_import_directory(&link, "not found", "not dir", "symlink not allowed")
                        .expect_err("symlink");
                assert!(err.contains("symlink"));
            }
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_destination_that_exists() {
        let root = temp_dir("exists");
        fs::write(root.join("a.md"), "a").expect("write");
        let dest = temp_db("exists-out");
        fs::write(&dest, "exists").expect("write dest");
        let err = import_markdown_tree(
            &root,
            &dest,
            "C:/other/current.sqlite3",
            &default_options(),
            "empty",
        )
        .expect_err("reject");
        assert!(err.contains("already exists"));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(dest);
    }

    #[test]
    fn front_matter_stripped_lf_and_crlf() {
        let lf = "---\ntitle: x\n---\n\nBody";
        let (_, body) = split_front_matter(lf);
        assert_eq!(body.trim(), "Body");
        let crlf = "---\r\ntitle: x\r\n---\r\n\r\nBody";
        let (_, body) = split_front_matter(crlf);
        assert_eq!(body.trim(), "Body");
    }

    #[test]
    fn loose_dash_line_is_not_front_matter() {
        let input = "Hello\n---\nStill body";
        let (fm, body) = split_front_matter(input);
        assert!(fm.is_none());
        assert_eq!(body, input);
        let input2 = "----\nBody";
        let (fm, body) = split_front_matter(input2);
        assert!(fm.is_none());
        assert_eq!(body, input2);
    }

    #[test]
    fn markdown_to_plain_text_basics() {
        let text = markdown_to_plain_text("# Heading\n\n**bold** *em* ~~strike~~", false);
        assert!(text.contains("Heading"));
        assert!(text.contains("bold"));
        assert!(text.contains("em"));
        assert!(text.contains("strike"));
        let link = markdown_to_plain_text("[Display](https://example.com)", false);
        assert_eq!(link.trim(), "Display");
        let img = markdown_to_plain_text("![Alt](img.png)", false);
        assert_eq!(img.trim(), "Alt");
        let no_alt = markdown_to_plain_text("![](img.png)", false);
        assert!(no_alt.trim().is_empty());
        let html = markdown_to_plain_text("<p>Hi</p>", false);
        assert!(html.contains("Hi"));
    }

    #[test]
    fn wiki_links_in_code_unchanged() {
        let fenced = markdown_to_plain_text("```\n[[Page]]\n```", true);
        assert!(fenced.contains("[[Page]]"));
        let inline = markdown_to_plain_text("`[[Page]]`", true);
        assert!(inline.contains("[[Page]]"));
    }

    #[test]
    fn media_embeds_in_code_unchanged() {
        let fenced = markdown_to_plain_text("```\n![[photo.png]]\n```", true);
        assert!(fenced.contains("![[photo.png]]"));
        let inline = markdown_to_plain_text("`![[photo.png]]`", true);
        assert!(inline.contains("![[photo.png]]"));
    }

    #[test]
    fn wiki_links_rewrite() {
        let text = markdown_to_plain_text("See [[Page]] and [[Page|Display]]", true);
        assert!(text.contains("Page"));
        assert!(text.contains("Display"));
        let embed = markdown_to_plain_text("![[photo.png]]", true);
        assert!(!embed.contains("photo.png"));
    }

    #[test]
    fn obsidian_wiki_link_media_and_image_handling() {
        let wiki_link = markdown_to_plain_text("[[photo.png]]", true);
        assert_eq!(wiki_link.trim(), "photo.png");

        let media_embed = markdown_to_plain_text("![[photo.png]]", true);
        assert!(!media_embed.contains("photo.png"));

        let markdown_image = markdown_to_plain_text("![A nice photo](photo.png)", true);
        assert_eq!(markdown_image.trim(), "A nice photo");
    }

    #[test]
    fn joplin_title_from_yaml_string_only() {
        assert_eq!(
            joplin_title_from_yaml("title: My Note"),
            Some("My Note".into())
        );
        assert_eq!(joplin_title_from_yaml("title: 42"), None);
        assert_eq!(joplin_title_from_yaml("title: ''"), None);
        assert_eq!(joplin_title_from_yaml("not: valid"), None);
    }
}
