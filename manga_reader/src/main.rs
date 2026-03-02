#![windows_subsystem = "windows"]

use eframe::egui;
use std::env;
use std::fs;
use std::io;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const ARCHIVE_IN_MEMORY_LIMIT_BYTES: usize = 1024 * 1024 * 1024;
const ARCHIVE_ESTIMATED_DECODED_LIMIT_BYTES: usize = 8192 * 1024 * 1024;

fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let mut a_iter = a.chars().peekable();
    let mut b_iter = b.chars().peekable();

    loop {
        let a_opt = a_iter.peek().copied();
        let b_opt = b_iter.peek().copied();

        match (a_opt, b_opt) {
            (Some(ac), Some(bc)) if ac.is_ascii_digit() && bc.is_ascii_digit() => {
                let mut a_num_str = String::new();
                while let Some(&c) = a_iter.peek() {
                    if c.is_ascii_digit() {
                        a_num_str.push(c);
                        a_iter.next();
                    } else {
                        break;
                    }
                }

                let mut b_num_str = String::new();
                while let Some(&c) = b_iter.peek() {
                    if c.is_ascii_digit() {
                        b_num_str.push(c);
                        b_iter.next();
                    } else {
                        break;
                    }
                }

                let a_trim = a_num_str.trim_start_matches('0');
                let b_trim = b_num_str.trim_start_matches('0');

                let cmp = a_trim
                    .len()
                    .cmp(&b_trim.len())
                    .then_with(|| a_trim.cmp(b_trim))
                    .then_with(|| a_num_str.len().cmp(&b_num_str.len()).reverse());

                if cmp != std::cmp::Ordering::Equal {
                    return cmp;
                }
            }
            (Some(ac), Some(bc)) => {
                let cmp = ac
                    .to_ascii_lowercase()
                    .cmp(&bc.to_ascii_lowercase())
                    .then_with(|| ac.cmp(&bc));
                if cmp != std::cmp::Ordering::Equal {
                    return cmp;
                }
                a_iter.next();
                b_iter.next();
            }
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (None, None) => return std::cmp::Ordering::Equal,
        }
    }
}

#[derive(serde::Deserialize, serde::Serialize, PartialEq, Clone, Copy)]
enum ViewMode {
    Scroll,
    SinglePage,
}

impl Default for ViewMode {
    fn default() -> Self {
        ViewMode::Scroll
    }
}

struct MangaReaderApp {
    images: Vec<ImageData>,
    folder_path: Option<String>,
    loading: bool,
    image_width: f32,
    image_height: f32,
    _temp_dir: Option<tempfile::TempDir>,
    view_mode: ViewMode,
    current_page: usize,
    app_title: Option<String>,
    scroll_accumulator: f32,
    load_receiver: Option<std::sync::mpsc::Receiver<LoadResultData>>,
    pending_load_path: Option<PathBuf>,
    scroll_area_id: String,
    scroll_to_page: Option<usize>,
    dark_mode: bool,
    reverse_left_right: bool,
}

impl Default for MangaReaderApp {
    fn default() -> Self {
        let initial_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_string();
        Self {
            images: Vec::new(),
            folder_path: None,
            loading: false,
            image_width: 0.0,
            image_height: 0.0,
            _temp_dir: None,
            view_mode: ViewMode::Scroll,
            current_page: 0,
            app_title: None,
            scroll_accumulator: 0.0,
            load_receiver: None,
            pending_load_path: None,
            scroll_area_id: initial_id,
            scroll_to_page: None,
            dark_mode: false,
            reverse_left_right: false,
        }
    }
}

enum ImageSource {
    File(PathBuf),
    Memory { uri: String, bytes: Arc<[u8]> },
}

struct ImageData {
    source: ImageSource,
    width: f32,
    height: f32,
}

struct LoadResultData {
    images: Vec<ImageData>,
    image_width: f32,
    image_height: f32,
    temp_dir: Option<tempfile::TempDir>,
}

fn do_load_images(folder_path: &str) -> (Vec<ImageData>, f32, f32) {
    let mut paths: Vec<PathBuf> = Vec::new();
    let pattern_jpg = format!("{}/**/*.jpg", glob::Pattern::escape(folder_path));
    let pattern_png = format!("{}/**/*.png", glob::Pattern::escape(folder_path));
    let pattern_jpeg = format!("{}/**/*.jpeg", glob::Pattern::escape(folder_path));
    let pattern_webp = format!("{}/**/*.webp", glob::Pattern::escape(folder_path));
    let pattern_gif = format!("{}/**/*.gif", glob::Pattern::escape(folder_path));

    let mut collect_paths = |pattern: &str| {
        let options = glob::MatchOptions {
            case_sensitive: false,
            require_literal_separator: false,
            require_literal_leading_dot: false,
        };
        if let Ok(glob_paths) = glob::glob_with(pattern, options) {
            paths.extend(glob_paths.filter_map(Result::ok));
        }
    };

    collect_paths(&pattern_jpg);
    collect_paths(&pattern_png);
    collect_paths(&pattern_jpeg);
    collect_paths(&pattern_webp);
    collect_paths(&pattern_gif);

    paths.sort_by(|a, b| natural_cmp(a.to_str().unwrap_or(""), b.to_str().unwrap_or("")));

    let mut images = Vec::new();
    let mut image_width = 0.0;
    let mut image_height = 0.0;

    for path in paths {
        let mut w = 0.0;
        let mut h = 0.0;
        if let Ok(dimensions) = image::image_dimensions(&path) {
            w = dimensions.0 as f32;
            h = dimensions.1 as f32;
        }

        if image_width == 0.0 && image_height == 0.0 && w > 0.0 {
            image_width = w;
            image_height = h;
        }

        images.push(ImageData {
            source: ImageSource::File(path),
            width: w,
            height: h,
        });
    }

    (images, image_width, image_height)
}

fn do_extract_archive(archive_path: &Path, ext: &str) -> Option<tempfile::TempDir> {
    if let Ok(temp_dir) = tempfile::Builder::new().prefix("manga_reader").tempdir() {
        let mut success = false;

        if ext == "zip" || ext == "cbz" {
            if let Ok(file) = fs::File::open(archive_path) {
                if let Ok(mut archive) = zip::ZipArchive::new(file) {
                    for i in 0..archive.len() {
                        if let Ok(mut file) = archive.by_index(i) {
                            let outpath = match file.enclosed_name() {
                                Some(path) => path.to_owned(),
                                None => continue,
                            };

                            if MangaReaderApp::is_supported_image(&outpath) {
                                let outpath = temp_dir.path().join(outpath);
                                if let Some(p) = outpath.parent() {
                                    if !p.exists() {
                                        let _ = fs::create_dir_all(&p);
                                    }
                                }
                                if let Ok(mut outfile) = fs::File::create(&outpath) {
                                    let _ = io::copy(&mut file, &mut outfile);
                                }
                            }
                        }
                    }
                    success = true;
                }
            }
        } else if ext == "7z" || ext == "cb7" {
            if sevenz_rust::decompress_file_with_extract_fn(
                archive_path,
                temp_dir.path(),
                |entry, reader, dest| {
                    if !entry.is_directory() {
                        let path = Path::new(entry.name());
                        if MangaReaderApp::is_supported_image(path) {
                            if let Some(p) = dest.parent() {
                                if !p.exists() {
                                    fs::create_dir_all(&p).unwrap_or(());
                                }
                            }
                            if let Ok(mut outfile) = fs::File::create(dest) {
                                let _ = io::copy(reader, &mut outfile);
                            } else {
                                let _ = io::copy(reader, &mut io::sink());
                            }
                        } else {
                            let _ = io::copy(reader, &mut io::sink());
                        }
                    }
                    Ok(true)
                },
            )
            .is_ok()
            {
                success = true;
            }
        } else if ext == "rar" || ext == "cbr" {
            let archive_path_str = archive_path.to_string_lossy().to_string();
            if let Ok(archive) = unrar::Archive::new(&archive_path_str).open_for_processing() {
                let mut current_archive = archive;
                loop {
                    match current_archive.read_header() {
                        Ok(Some(header)) => {
                            let filename = header.entry().filename.to_string_lossy().into_owned();
                            let is_file = header.entry().is_file();
                            if is_file && MangaReaderApp::is_supported_image(Path::new(&filename)) {
                                let outpath = temp_dir.path().join(&filename);
                                if let Some(p) = outpath.parent() {
                                    if !p.exists() {
                                        fs::create_dir_all(&p).unwrap_or(());
                                    }
                                }
                                match header.extract_to(&outpath) {
                                    Ok(next) => current_archive = next,
                                    Err(_) => break,
                                }
                            } else {
                                match header.skip() {
                                    Ok(next) => current_archive = next,
                                    Err(_) => break,
                                }
                            }
                        }
                        _ => break,
                    }
                }
                success = true;
            }
        }

        if success {
            return Some(temp_dir);
        }
    }
    None
}

fn do_load_archive(archive_path: &Path) -> Option<LoadResultData> {
    let ext = archive_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mut memory_images: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total_encoded_bytes = 0usize;
    let mut total_estimated_decoded_bytes = 0usize;
    let mut memory_limit_exceeded = false;

    if ext == "zip" || ext == "cbz" {
        if let Ok(file) = std::fs::File::open(archive_path) {
            if let Ok(mut archive) = zip::ZipArchive::new(file) {
                for i in 0..archive.len() {
                    if let Ok(mut file) = archive.by_index(i) {
                        if file.is_dir() {
                            continue;
                        }

                        let image_name = match file.enclosed_name() {
                            Some(path) if MangaReaderApp::is_supported_image(&path) => {
                                path.to_string_lossy().to_string()
                            }
                            _ => continue,
                        };

                        let mut bytes = Vec::new();
                        if file.read_to_end(&mut bytes).is_ok() {
                            total_encoded_bytes = total_encoded_bytes.saturating_add(bytes.len());
                            total_estimated_decoded_bytes = total_estimated_decoded_bytes
                                .saturating_add(
                                    MangaReaderApp::estimated_decoded_bytes_from_image_bytes(
                                        &bytes,
                                    ),
                                );
                            if total_encoded_bytes > ARCHIVE_IN_MEMORY_LIMIT_BYTES
                                || total_estimated_decoded_bytes
                                    > ARCHIVE_ESTIMATED_DECODED_LIMIT_BYTES
                            {
                                memory_limit_exceeded = true;
                                break;
                            }
                            memory_images.push((image_name, bytes));
                        }
                    }
                }
            }
        }
    } else if ext == "7z" || ext == "cb7" {
        let _ = sevenz_rust::decompress_file_with_extract_fn(
            archive_path,
            Path::new("."),
            |entry, reader, _dest| {
                if entry.is_directory() {
                    return Ok(true);
                }

                let image_name = entry.name().replace('\\', "/");
                if MangaReaderApp::is_supported_image(Path::new(&image_name)) {
                    let mut bytes = Vec::new();
                    if reader.read_to_end(&mut bytes).is_ok() {
                        total_encoded_bytes = total_encoded_bytes.saturating_add(bytes.len());
                        total_estimated_decoded_bytes = total_estimated_decoded_bytes
                            .saturating_add(
                                MangaReaderApp::estimated_decoded_bytes_from_image_bytes(&bytes),
                            );
                        if total_encoded_bytes > ARCHIVE_IN_MEMORY_LIMIT_BYTES
                            || total_estimated_decoded_bytes > ARCHIVE_ESTIMATED_DECODED_LIMIT_BYTES
                        {
                            memory_limit_exceeded = true;
                            return Ok(true);
                        }
                        memory_images.push((image_name, bytes));
                    }
                } else {
                    let _ = io::copy(reader, &mut io::sink());
                }
                Ok(true)
            },
        );
    } else if ext == "rar" || ext == "cbr" {
        let archive_path_str = archive_path.to_string_lossy().to_string();
        if let Ok(archive) = unrar::Archive::new(&archive_path_str).open_for_processing() {
            let mut current_archive = archive;
            loop {
                match current_archive.read_header() {
                    Ok(Some(header)) => {
                        let filename = header.entry().filename.to_string_lossy().into_owned();
                        let is_file = header.entry().is_file();

                        if is_file && MangaReaderApp::is_supported_image(Path::new(&filename)) {
                            match header.read() {
                                Ok((bytes, next)) => {
                                    total_encoded_bytes =
                                        total_encoded_bytes.saturating_add(bytes.len());
                                    total_estimated_decoded_bytes = total_estimated_decoded_bytes
                                        .saturating_add(
                                        MangaReaderApp::estimated_decoded_bytes_from_image_bytes(
                                            &bytes,
                                        ),
                                    );
                                    if total_encoded_bytes > ARCHIVE_IN_MEMORY_LIMIT_BYTES
                                        || total_estimated_decoded_bytes
                                            > ARCHIVE_ESTIMATED_DECODED_LIMIT_BYTES
                                    {
                                        memory_limit_exceeded = true;
                                        break;
                                    }
                                    memory_images.push((filename, bytes));
                                    current_archive = next;
                                }
                                Err(_) => break,
                            }
                        } else {
                            match header.skip() {
                                Ok(next) => current_archive = next,
                                Err(_) => break,
                            }
                        }
                    }
                    _ => break,
                }
            }
        }
    }

    if memory_limit_exceeded {
        if let Some(temp_dir) = do_extract_archive(archive_path, &ext) {
            let temp_path = temp_dir.path().to_str().unwrap_or("").to_string();
            let (images, image_width, image_height) = do_load_images(&temp_path);
            return Some(LoadResultData {
                images,
                image_width,
                image_height,
                temp_dir: Some(temp_dir),
            });
        }
        return None;
    }

    memory_images.sort_by(|a, b| natural_cmp(&a.0, &b.0));

    let mut images = Vec::new();
    let mut image_width = 0.0;
    let mut image_height = 0.0;

    for (index, (name, bytes)) in memory_images.into_iter().enumerate() {
        let (w, h) = MangaReaderApp::image_dimensions_from_bytes(&bytes);
        if image_width == 0.0 && image_height == 0.0 && w > 0.0 {
            image_width = w;
            image_height = h;
        }

        let archive_name = archive_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("archive");
        let uri = format!(
            "bytes://{}/{}-{}",
            archive_name,
            index,
            name.replace('\\', "/")
        );

        images.push(ImageData {
            source: ImageSource::Memory {
                uri,
                bytes: Arc::from(bytes),
            },
            width: w,
            height: h,
        });
    }

    Some(LoadResultData {
        images,
        image_width,
        image_height,
        temp_dir: None,
    })
}

impl MangaReaderApp {
    fn clear_loaded_images(&mut self, ctx: Option<&egui::Context>) {
        if let Some(ctx) = ctx {
            ctx.forget_all_images();
        }
        self.images.clear();
        self.folder_path = None;
        self.image_width = 0.0;
        self.image_height = 0.0;
        self.current_page = 0;
        self.scroll_to_page = None;
        self._temp_dir = None;
        self.load_receiver = None;

        self.scroll_area_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_string();
    }

    fn estimated_decoded_bytes_from_image_bytes(bytes: &[u8]) -> usize {
        let (w, h) = Self::image_dimensions_from_bytes(bytes);
        if w > 0.0 && h > 0.0 {
            (w as usize).saturating_mul(h as usize).saturating_mul(4)
        } else {
            0
        }
    }

    fn load_images(&mut self, folder_path: &str, ctx: Option<&egui::Context>) {
        self.images.clear();
        self.image_width = 0.0;
        self.image_height = 0.0;
        self.loading = true;
        self.current_page = 0;
        self.folder_path = Some(folder_path.to_string());

        let (tx, rx) = std::sync::mpsc::channel();
        self.load_receiver = Some(rx);

        let folder_path_clone = folder_path.to_string();
        let ctx_clone = ctx.cloned();

        std::thread::spawn(move || {
            let (images, image_width, image_height) = do_load_images(&folder_path_clone);
            let _ = tx.send(LoadResultData {
                images,
                image_width,
                image_height,
                temp_dir: None,
            });
            if let Some(ctx) = ctx_clone {
                ctx.request_repaint();
            }
        });
    }

    fn open_folder_dialog(&mut self, ctx: &egui::Context) {
        if let Some(path) = rfd::FileDialog::new().pick_folder() {
            self.clear_loaded_images(Some(ctx));
            self.app_title = path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string());
            if let Some(title) = &self.app_title {
                ctx.send_viewport_cmd(egui::ViewportCommand::Title(format!(
                    "Manga Reader - {}",
                    title
                )));
            }
            self.load_images(path.to_str().unwrap_or(""), Some(ctx));
            ctx.request_repaint();
        }
    }

    fn is_supported_image(path: &Path) -> bool {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        ext == "jpg" || ext == "jpeg" || ext == "png" || ext == "webp" || ext == "gif"
    }

    fn image_dimensions_from_bytes(bytes: &[u8]) -> (f32, f32) {
        if let Ok(reader) =
            image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()
        {
            if let Ok(dimensions) = reader.into_dimensions() {
                return (dimensions.0 as f32, dimensions.1 as f32);
            }
        }
        (0.0, 0.0)
    }

    fn archive_image_widget(image_data: &ImageData) -> egui::Image<'static> {
        match &image_data.source {
            ImageSource::File(path) => {
                let uri = format!("file://{}", path.to_string_lossy());
                egui::Image::new(uri)
            }
            ImageSource::Memory { uri, bytes } => {
                egui::Image::from_bytes(uri.clone(), bytes.clone())
            }
        }
    }

    fn get_image_uri(&self, index: usize) -> Option<String> {
        if index >= self.images.len() {
            return None;
        }
        match &self.images[index].source {
            ImageSource::File(path) => Some(format!("file://{}", path.to_string_lossy())),
            ImageSource::Memory { uri, .. } => Some(uri.clone()),
        }
    }

    fn load_archive_path(&mut self, archive_path: &Path, ctx: Option<&egui::Context>) {
        self.app_title = archive_path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());
        if let Some(ctx) = ctx {
            if let Some(title) = &self.app_title {
                ctx.send_viewport_cmd(egui::ViewportCommand::Title(format!(
                    "Manga Reader - {}",
                    title
                )));
            }
        }

        self.clear_loaded_images(ctx);
        self.loading = true;
        self.folder_path = Some(archive_path.to_string_lossy().to_string());

        let (tx, rx) = std::sync::mpsc::channel();
        self.load_receiver = Some(rx);

        let archive_path_clone = archive_path.to_path_buf();
        let ctx_clone = ctx.cloned();

        std::thread::spawn(move || {
            if let Some(data) = do_load_archive(&archive_path_clone) {
                let _ = tx.send(data);
            } else {
                let _ = tx.send(LoadResultData {
                    images: Vec::new(),
                    image_width: 0.0,
                    image_height: 0.0,
                    temp_dir: None,
                });
            }
            if let Some(ctx) = ctx_clone {
                ctx.request_repaint();
            }
        });
    }

    fn open_path(&mut self, path: &Path, ctx: Option<&egui::Context>) {
        self.app_title = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());
        if let Some(ctx) = ctx {
            if let Some(title) = &self.app_title {
                ctx.send_viewport_cmd(egui::ViewportCommand::Title(format!(
                    "Manga Reader - {}",
                    title
                )));
            }
        }
        if path.is_dir() {
            self.clear_loaded_images(ctx);
            self.load_images(path.to_str().unwrap_or(""), ctx);
        } else if path.is_file() {
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if ext == "zip"
                || ext == "cbz"
                || ext == "7z"
                || ext == "cb7"
                || ext == "rar"
                || ext == "cbr"
            {
                self.load_archive_path(path, ctx);
            }
        }
    }

    fn open_archive_dialog(&mut self, ctx: &egui::Context) {
        if let Some(path) = rfd::FileDialog::new()
            .add_filter("Archive", &["zip", "cbz", "rar", "cbr", "7z", "cb7"])
            .pick_file()
        {
            self.load_archive_path(&path, Some(ctx));
            ctx.request_repaint();
        }
    }
}

impl eframe::App for MangaReaderApp {
    fn save(&mut self, storage: &mut dyn eframe::Storage) {
        eframe::set_value(storage, "view_mode", &self.view_mode);
        eframe::set_value(storage, "dark_mode", &self.dark_mode);
        eframe::set_value(storage, "reverse_left_right", &self.reverse_left_right);
    }

    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let is_dark = ctx.style().visuals.dark_mode;
        if self.dark_mode != is_dark {
            ctx.set_visuals(if self.dark_mode {
                egui::Visuals::dark()
            } else {
                egui::Visuals::light()
            });
        }

        if ctx.input(|i| {
            i.key_pressed(egui::Key::Escape) || i.pointer.button_clicked(egui::PointerButton::Extra1)
        }) {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }

        let dropped_file = ctx.input(|i| {
            i.raw.dropped_files.first().and_then(|f| f.path.clone())
        });
        if let Some(path) = dropped_file {
            self.pending_load_path = Some(path);
        }

        if let Some(path) = self.pending_load_path.take() {
            self.open_path(&path, Some(ctx));
        }

        if let Some(rx) = &self.load_receiver {
            if let Ok(data) = rx.try_recv() {
                self.images = data.images;
                self.image_width = data.image_width;
                self.image_height = data.image_height;
                if data.temp_dir.is_some() {
                    self._temp_dir = data.temp_dir;
                }
                self.loading = false;
                self.load_receiver = None;
            }
        }

        let mut scroll_delta = 0.0;
        let mut requests_repaint = false;

        let mut target_page = self.current_page;

        let screen_height = ctx.screen_rect().height();
        let page_scroll_amount = screen_height * 0.85;

        ctx.input(|i| {
            let dt = i.stable_dt;
            if self.view_mode == ViewMode::Scroll {
                if i.key_down(egui::Key::ArrowUp) {
                    scroll_delta += 1500.0 * dt;
                    requests_repaint = true;
                }
                if i.key_down(egui::Key::ArrowDown) {
                    scroll_delta -= 1500.0 * dt;
                    requests_repaint = true;
                }
                if i.key_pressed(egui::Key::ArrowLeft) {
                    let dir = if self.reverse_left_right { -1.0 } else { 1.0 };
                    scroll_delta += page_scroll_amount * dir;
                    requests_repaint = true;
                }
                if i.key_pressed(egui::Key::ArrowRight) {
                    let dir = if self.reverse_left_right { 1.0 } else { -1.0 };
                    scroll_delta += page_scroll_amount * dir;
                    requests_repaint = true;
                }
                if i.key_pressed(egui::Key::Space) {
                    scroll_delta -= page_scroll_amount;
                    requests_repaint = true;
                }
            } else {
                let mut next_page = false;
                let mut prev_page = false;

                if i.key_pressed(egui::Key::ArrowRight) {
                    if self.reverse_left_right {
                        prev_page = true;
                    } else {
                        next_page = true;
                    }
                    requests_repaint = true;
                }
                if i.key_pressed(egui::Key::ArrowLeft) {
                    if self.reverse_left_right {
                        next_page = true;
                    } else {
                        prev_page = true;
                    }
                    requests_repaint = true;
                }
                if i.key_pressed(egui::Key::Space) {
                    next_page = true;
                    requests_repaint = true;
                }

                let scroll_y = i.smooth_scroll_delta.y;
                if scroll_y != 0.0 {
                    self.scroll_accumulator += scroll_y;
                } else {
                    self.scroll_accumulator *= 0.8_f32.powf(dt * 60.0);
                }

                if self.scroll_accumulator > 40.0 {
                    prev_page = true;
                    self.scroll_accumulator = 0.0;
                    requests_repaint = true;
                } else if self.scroll_accumulator < -40.0 {
                    next_page = true;
                    self.scroll_accumulator = 0.0;
                    requests_repaint = true;
                }

                if next_page && !self.images.is_empty() && target_page + 1 < self.images.len() {
                    target_page += 1;
                    scroll_delta = 0.0;
                }
                if prev_page && target_page > 0 {
                    target_page -= 1;
                    scroll_delta = 0.0;
                }
            }
        });

        let fill_color = if self.dark_mode {
            egui::Color32::from_rgb(30, 30, 30)
        } else {
            egui::Color32::from_rgb(240, 240, 240)
        };

        let frame = egui::Frame::central_panel(&ctx.style())
            .fill(fill_color);

        egui::CentralPanel::default().frame(frame).show(ctx, |ui| {
            if self.images.is_empty() {
                ui.heading("Manga Reader");
                ui.add_space(20.0);

                ui.horizontal(|ui| {
                    if ui.button("Open Folder").clicked() {
                        self.open_folder_dialog(ctx);
                    }
                    if ui.button("Open Archive (.zip, etc.)").clicked() {
                        self.open_archive_dialog(ctx);
                    }
                    ui.separator();
                    let mode_text = if self.dark_mode { "🌙 Dark" } else { "☀ Light" };
                    if ui.button(mode_text).clicked() {
                        self.dark_mode = !self.dark_mode;
                    }
                    ui.separator();
                    ui.checkbox(&mut self.reverse_left_right, "Reverse L/R page turn");
                });
                ui.add_space(10.0);
                ui.label("Click button or drop files here to select manga folder or archive");
                ui.add_space(20.0);

                ui.heading("Controls");
                ui.add_space(5.0);
                ui.label("Scroll Mode:");
                ui.label("  • Mouse Wheel: Scroll vertically");
                ui.label("  • Up/Down Arrows: Scroll smoothly");
                ui.label("  • Left/Right Arrows: Scroll by page (affected by RTL)");
                ui.label("  • Space: Next page scroll");

                ui.add_space(5.0);
                ui.label("Single Page Mode:");
                ui.label("  • Mouse Wheel: Change page");
                ui.label("  • Left/Right Arrows: Change page (affected by RTL)");
                ui.label("  • Space: Next page");
                ui.label("  • Click Left/Right side: Previous/Next page (affected by RTL)");

                ui.add_space(5.0);
                ui.label("Global:");
                ui.label("  • Esc / Mouse Back: Close window");

                if self.loading {
                    ui.add_space(20.0);
                    ui.horizontal(|ui| {
                        ui.spinner();
                        ui.heading("Loading...");
                    });
                }
            } else {
                ui.horizontal(|ui| {
                    if ui.button("Open Folder").clicked() {
                        self.open_folder_dialog(ctx);
                    }
                    if ui.button("Open Archive").clicked() {
                        self.open_archive_dialog(ctx);
                    }
                    if ui.button("Close").clicked() {
                        self.clear_loaded_images(Some(ctx));
                        self.app_title = None;
                        ctx.send_viewport_cmd(egui::ViewportCommand::Title(
                            "Manga Reader".to_string(),
                        ));
                    }

                    ui.separator();

                    let prev_view_mode = self.view_mode;
                    ui.selectable_value(&mut self.view_mode, ViewMode::Scroll, "Scroll");
                    ui.selectable_value(&mut self.view_mode, ViewMode::SinglePage, "Single Page");
                    if prev_view_mode != self.view_mode && self.view_mode == ViewMode::Scroll {
                        self.scroll_to_page = Some(self.current_page);
                    }
                    ui.checkbox(&mut self.reverse_left_right, "RTL");

                    ui.separator();

                    let mode_text = if self.dark_mode { "🌙 Dark" } else { "☀ Light" };
                    if ui.button(mode_text).clicked() {
                        self.dark_mode = !self.dark_mode;
                    }

                    if self.loading {
                        ui.label(" (Loading...)");
                    }
                });

                ui.separator();

                if self.view_mode == ViewMode::Scroll {
                    let mut visible_range: Option<(usize, usize)> = None;

                    egui::ScrollArea::vertical()
                        .id_salt(&self.scroll_area_id)
                        .auto_shrink([false; 2])
                        .stick_to_bottom(false)
                        .wheel_scroll_multiplier(egui::vec2(3.0, 3.0))
                        .show(ui, |ui| {
                            if scroll_delta != 0.0 {
                                ui.scroll_with_delta(egui::vec2(0.0, scroll_delta));
                            }

                            let display_width =
                                ui.available_width().min(if self.image_width > 0.0 {
                                    self.image_width * 1.5
                                } else {
                                    2000.0
                                });
                            let total_images = self.images.len();

                            for (index, image_data) in self.images.iter().enumerate() {
                                ui.vertical_centered(|ui| {
                                    let mut w = image_data.width;
                                    let mut h = image_data.height;
                                    if w == 0.0 || h == 0.0 {
                                        w = self.image_width;
                                        h = self.image_height;
                                    }
                                    if w == 0.0 || h == 0.0 {
                                        w = 800.0;
                                        h = 1200.0;
                                    }

                                    let scale = if w > 0.0 {
                                        (display_width / w).min(1.0)
                                    } else {
                                        1.0
                                    };
                                    let final_w = w * scale;
                                    let final_h = h * scale;
                                    let image_size = egui::vec2(final_w, final_h);

                                    let (rect, _response) =
                                        ui.allocate_exact_size(image_size, egui::Sense::hover());

                                    if Some(index) == self.scroll_to_page {
                                        ui.scroll_to_rect(rect, Some(egui::Align::TOP));
                                    }

                                    if ui.is_rect_visible(rect) {
                                        match &mut visible_range {
                                            Some((min_idx, max_idx)) => {
                                                *min_idx = (*min_idx).min(index);
                                                *max_idx = (*max_idx).max(index);
                                            }
                                            None => visible_range = Some((index, index)),
                                        }

                                        let image_widget = Self::archive_image_widget(image_data);
                                        image_widget.paint_at(ui, rect);

                                        let painter = ui.painter();
                                        let text = format!("{}/{}", index + 1, total_images);
                                        let font_id = egui::FontId::proportional(12.0);
                                        let text_color = egui::Color32::WHITE;
                                        let bg_color = egui::Color32::from_black_alpha(160);
                                        let galley =
                                            painter.layout_no_wrap(text, font_id, text_color);
                                        let margin = egui::vec2(6.0, 3.0);
                                        let text_rect = galley.rect;
                                        let bg_rect = egui::Rect::from_min_size(
                                            rect.right_bottom()
                                                - text_rect.size()
                                                - margin * 2.0
                                                - egui::vec2(10.0, 10.0),
                                            text_rect.size() + margin * 2.0,
                                        );
                                        painter.rect_filled(bg_rect, 4.0, bg_color);
                                        painter.galley(bg_rect.min + margin, galley, text_color);
                                    }
                                    ui.add_space(4.0);
                                });
                            }
                        });

                    let did_scroll_to_page = self.scroll_to_page.is_some();
                    if did_scroll_to_page {
                        self.scroll_to_page = None;
                    }

                    if let Some((min_idx, max_idx)) = visible_range {
                        if !did_scroll_to_page {
                            self.current_page = min_idx;
                            target_page = min_idx;
                        }

                        let keep_min = min_idx.saturating_sub(3);
                        let keep_max = max_idx.saturating_add(3);

                        for i in keep_min..=keep_max {
                            if i < self.images.len() && (i < min_idx || i > max_idx) {
                                let pre_image_data = &self.images[i];
                                let pre_image = Self::archive_image_widget(pre_image_data);
                                let _ = pre_image.load_for_size(ui.ctx(), ui.available_size());
                            }
                        }

                        for i in 0..self.images.len() {
                            if i < keep_min || i > keep_max {
                                if let Some(uri) = self.get_image_uri(i) {
                                    ctx.forget_image(&uri);
                                }
                            }
                        }
                    }
                } else {
                    let available_height = ui.available_height();
                    egui::ScrollArea::vertical()
                        .id_salt(&self.scroll_area_id)
                        .auto_shrink([false; 2])
                        .stick_to_bottom(false)
                        .wheel_scroll_multiplier(egui::vec2(0.0, 0.0))
                        .show(ui, |ui| {
                            if scroll_delta != 0.0 {
                                ui.scroll_with_delta(egui::vec2(0.0, scroll_delta));
                            }

                            if self.current_page < self.images.len() {
                                let image_data = &self.images[self.current_page];

                                ui.vertical_centered(|ui| {
                                    let display_width = ui.available_width();
                                    let mut w = image_data.width;
                                    let mut h = image_data.height;
                                    if w == 0.0 || h == 0.0 {
                                        w = self.image_width;
                                        h = self.image_height;
                                    }
                                    if w == 0.0 || h == 0.0 {
                                        w = 800.0;
                                        h = 1200.0;
                                    }

                                    let scale_w = display_width / w;
                                    let scale_h = available_height / h;
                                    let scale = scale_w.min(scale_h).min(1.0);
                                    let final_w = w * scale;
                                    let final_h = h * scale;

                                    if final_h < available_height - 1.0 {
                                        let padding = (available_height - final_h) / 2.0;
                                        ui.add_space(padding);
                                    }

                                    let img_response = ui.add(
                                        Self::archive_image_widget(image_data)
                                            .fit_to_exact_size(egui::vec2(final_w, final_h)),
                                    );

                                    let clip_rect = ui.clip_rect();
                                    let click_response = ui.interact(
                                        clip_rect,
                                        ui.id().with("single_page_click"),
                                        egui::Sense::click(),
                                    );

                                    if click_response.clicked() {
                                        if let Some(pos) = click_response.interact_pointer_pos() {
                                            let clicked_right = pos.x > clip_rect.center().x;
                                            let next_on_right = !self.reverse_left_right;
                                            let go_next = if clicked_right {
                                                next_on_right
                                            } else {
                                                !next_on_right
                                            };

                                            if go_next {
                                                if target_page + 1 < self.images.len() {
                                                    target_page += 1;
                                                    requests_repaint = true;
                                                }
                                            } else if target_page > 0 {
                                                target_page -= 1;
                                                requests_repaint = true;
                                            }
                                        }
                                    }

                                    let painter = ui.painter();
                                    let rect = img_response.rect;
                                    let text =
                                        format!("{}/{}", self.current_page + 1, self.images.len());
                                    let font_id = egui::FontId::proportional(12.0);
                                    let text_color = egui::Color32::WHITE;
                                    let bg_color = egui::Color32::from_black_alpha(160);
                                    let galley = painter.layout_no_wrap(text, font_id, text_color);
                                    let margin = egui::vec2(6.0, 3.0);
                                    let text_rect = galley.rect;
                                    let bg_rect = egui::Rect::from_min_size(
                                        rect.right_bottom()
                                            - text_rect.size()
                                            - margin * 2.0
                                            - egui::vec2(10.0, 10.0),
                                        text_rect.size() + margin * 2.0,
                                    );
                                    painter.rect_filled(bg_rect, 4.0, bg_color);
                                    painter.galley(bg_rect.min + margin, galley, text_color);

                                    if final_h < available_height - 1.0 {
                                        ui.add_space(4.0);
                                    }
                                });

                                let pre_min = self.current_page.saturating_sub(3);
                                let pre_max = self
                                    .current_page
                                    .saturating_add(3)
                                    .min(self.images.len().saturating_sub(1));
                                for i in pre_min..=pre_max {
                                    if i != self.current_page {
                                        let pre_image_data = &self.images[i];
                                        let pre_image = Self::archive_image_widget(pre_image_data);
                                        let _ =
                                            pre_image.load_for_size(ui.ctx(), ui.available_size());
                                    }
                                }
                            }
                        });
                }
            }
        });

        if self.view_mode == ViewMode::SinglePage && target_page != self.current_page {
            let keep_min = target_page.saturating_sub(3);
            let keep_max = target_page.saturating_add(3);
            for i in 0..self.images.len() {
                if i < keep_min || i > keep_max {
                    if let Some(uri) = self.get_image_uri(i) {
                        ctx.forget_image(&uri);
                    }
                }
            }
            self.current_page = target_page;
            requests_repaint = true;
        } else if self.view_mode == ViewMode::Scroll && target_page != self.current_page {
            self.current_page = target_page;
        }

        if requests_repaint {
            ctx.request_repaint();
        }
    }
}

fn main() -> eframe::Result<()> {
    let args: Vec<String> = env::args().collect();
    let mut app = MangaReaderApp::default();

    if let Some(path_str) = args.get(1) {
        app.pending_load_path = Some(PathBuf::from(path_str));
    }

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_app_id("manga_reader_app")
            .with_inner_size([1000.0, 700.0])
            .with_min_inner_size([400.0, 300.0])
            .with_title(
                app.app_title
                    .as_ref()
                    .map(|t| format!("Manga Reader - {}", t))
                    .unwrap_or_else(|| "Manga Reader".to_string()),
            ),
        ..Default::default()
    };

    eframe::run_native(
        "Manga Reader",
        options,
        Box::new(move |cc| {
            egui_extras::install_image_loaders(&cc.egui_ctx);
            if let Some(storage) = cc.storage {
                if let Some(view_mode) = eframe::get_value(storage, "view_mode") {
                    app.view_mode = view_mode;
                }
                if let Some(dark_mode) = eframe::get_value(storage, "dark_mode") {
                    app.dark_mode = dark_mode;
                }
                if let Some(reverse_left_right) = eframe::get_value(storage, "reverse_left_right") {
                    app.reverse_left_right = reverse_left_right;
                }
            }
            Ok(Box::new(app))
        }),
    )
}
