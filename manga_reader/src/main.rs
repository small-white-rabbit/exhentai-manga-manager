#![windows_subsystem = "windows"]

use eframe::egui;
use glob::glob;
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

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

                let cmp = a_trim.len().cmp(&b_trim.len())
                    .then_with(|| a_trim.cmp(b_trim))
                    .then_with(|| a_num_str.len().cmp(&b_num_str.len()).reverse());

                if cmp != std::cmp::Ordering::Equal {
                    return cmp;
                }
            }
            (Some(ac), Some(bc)) => {
                let cmp = ac.to_ascii_lowercase().cmp(&bc.to_ascii_lowercase())
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
}

impl Default for MangaReaderApp {
    fn default() -> Self {
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
        }
    }
}

struct ImageData {
    path: PathBuf,
    width: f32,
    height: f32,
}

impl MangaReaderApp {
    fn load_images(&mut self, folder_path: &str) {
        self.images.clear();
        self.image_width = 0.0;
        self.image_height = 0.0;
        self.loading = true;
        self.current_page = 0;
        self.folder_path = Some(folder_path.to_string());

        let mut paths: Vec<PathBuf> = Vec::new();
        // Use proper escaping to prevent panics when folder path contains brackets
        let pattern_jpg = format!("{}/**/*.jpg", glob::Pattern::escape(folder_path));
        let pattern_png = format!("{}/**/*.png", glob::Pattern::escape(folder_path));
        let pattern_jpeg = format!("{}/**/*.jpeg", glob::Pattern::escape(folder_path));
        let pattern_webp = format!("{}/**/*.webp", glob::Pattern::escape(folder_path));
        let pattern_gif = format!("{}/**/*.gif", glob::Pattern::escape(folder_path));

        let mut collect_paths = |pattern: &str| {
            if let Ok(glob_paths) = glob(pattern) {
                paths.extend(glob_paths.filter_map(Result::ok));
            }
        };

        collect_paths(&pattern_jpg);
        collect_paths(&pattern_png);
        collect_paths(&pattern_jpeg);
        collect_paths(&pattern_webp);
        collect_paths(&pattern_gif);

        paths.sort_by(|a, b| {
            natural_cmp(
                a.to_str().unwrap_or(""),
                b.to_str().unwrap_or(""),
            )
        });

        for path in paths {
            let mut w = 0.0;
            let mut h = 0.0;
            if let Ok(dimensions) = image::image_dimensions(&path) {
                w = dimensions.0 as f32;
                h = dimensions.1 as f32;
            } else if let Ok(img) = image::open(&path) {
                w = img.width() as f32;
                h = img.height() as f32;
            }

            if self.image_width == 0.0 && self.image_height == 0.0 && w > 0.0 {
                self.image_width = w;
                self.image_height = h;
            }
            self.images.push(ImageData {
                path,
                width: w,
                height: h,
            });
        }

        if self.images.is_empty() {
            self.loading = false;
        }
    }

    fn load_textures(&mut self, _ctx: &egui::Context) {
        // eframe::egui Image handles loading and caching automatically
        self.loading = false;
    }

    fn open_folder_dialog(&mut self, ctx: &egui::Context) {
        if let Some(path) = rfd::FileDialog::new().pick_folder() {
            self._temp_dir = None; // clear previous temp dir
            self.app_title = path.file_name().and_then(|n| n.to_str()).map(|s| s.to_string());
            if let Some(title) = &self.app_title {
                ctx.send_viewport_cmd(egui::ViewportCommand::Title(format!("Manga Reader - {}", title)));
            }
            self.load_images(path.to_str().unwrap_or(""));
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

    fn load_archive_path(&mut self, archive_path: &Path, ctx: Option<&egui::Context>) {
        self.app_title = archive_path.file_name().and_then(|n| n.to_str()).map(|s| s.to_string());
        if let Some(ctx) = ctx {
            if let Some(title) = &self.app_title {
                ctx.send_viewport_cmd(egui::ViewportCommand::Title(format!("Manga Reader - {}", title)));
            }
        }
        let ext = archive_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

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

                                if Self::is_supported_image(&outpath) {
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
                            if Self::is_supported_image(path) {
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
                                let filename =
                                    header.entry().filename.to_string_lossy().into_owned();
                                let is_file = header.entry().is_file();
                                if is_file && Self::is_supported_image(Path::new(&filename)) {
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
                let temp_path = temp_dir.path().to_str().unwrap_or("").to_string();
                self._temp_dir = Some(temp_dir);
                self.load_images(&temp_path);
            }
        }
    }

    fn open_path(&mut self, path: &Path, ctx: Option<&egui::Context>) {
        self.app_title = path.file_name().and_then(|n| n.to_str()).map(|s| s.to_string());
        if let Some(ctx) = ctx {
            if let Some(title) = &self.app_title {
                ctx.send_viewport_cmd(egui::ViewportCommand::Title(format!("Manga Reader - {}", title)));
            }
        }
        if path.is_dir() {
            self._temp_dir = None;
            self.load_images(path.to_str().unwrap_or(""));
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
    }

    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.load_textures(ctx);

        let mut scroll_delta = 0.0;
        let mut requests_repaint = false;

        let mut next_page = false;
        let mut prev_page = false;

        let screen_height = ctx.screen_rect().height();
        let page_scroll_amount = screen_height * 0.85;

        ctx.input(|i| {
            let dt = i.stable_dt;
            if self.view_mode == ViewMode::Scroll {
                if i.key_down(egui::Key::W) || i.key_down(egui::Key::ArrowUp) {
                    scroll_delta += 1500.0 * dt;
                    requests_repaint = true;
                }
                if i.key_down(egui::Key::S) || i.key_down(egui::Key::ArrowDown) {
                    scroll_delta -= 1500.0 * dt;
                    requests_repaint = true;
                }
                if i.key_pressed(egui::Key::PageUp) {
                    scroll_delta += page_scroll_amount;
                    requests_repaint = true;
                }
                if i.key_pressed(egui::Key::PageDown) {
                    scroll_delta -= page_scroll_amount;
                    requests_repaint = true;
                }
            } else {
                if i.key_pressed(egui::Key::ArrowRight)
                    || i.key_pressed(egui::Key::PageDown)
                    || i.key_pressed(egui::Key::Space)
                {
                    next_page = true;
                    requests_repaint = true;
                }
                if i.key_pressed(egui::Key::ArrowLeft) || i.key_pressed(egui::Key::PageUp) {
                    prev_page = true;
                    requests_repaint = true;
                }
                if i.key_down(egui::Key::W) || i.key_down(egui::Key::ArrowUp) {
                    scroll_delta += 1500.0 * dt;
                    requests_repaint = true;
                }
                if i.key_down(egui::Key::S) || i.key_down(egui::Key::ArrowDown) {
                    scroll_delta -= 1500.0 * dt;
                    requests_repaint = true;
                }
            }
        });

        if next_page && self.current_page + 1 < self.images.len() {
            self.current_page += 1;
            scroll_delta = 0.0;
        }
        if prev_page && self.current_page > 0 {
            self.current_page -= 1;
            scroll_delta = 0.0;
        }

        if requests_repaint {
            ctx.request_repaint();
        }

        egui::CentralPanel::default().show(ctx, |ui| {
            if self.images.is_empty() {
                ui.heading("Manga Reader");
                ui.add_space(20.0);

                ui.horizontal(|ui| {
                    let btn = ui.button("Open Folder");
                    if btn.clicked() {
                        self.open_folder_dialog(ctx);
                    }

                    let archive_btn = ui.button("Open Archive (.zip, etc.)");
                    if archive_btn.clicked() {
                        self.open_archive_dialog(ctx);
                    }
                });

                ui.add_space(10.0);
                ui.label("Click button to select manga folder or archive");
                ui.add_space(20.0);
                ui.label("Keys: W/S or PageUp/PageDown to scroll");

                if self.loading {
                    ui.add_space(10.0);
                    ui.label("Loading...");
                }
            } else {
                ui.horizontal(|ui| {
                    let open_btn = ui.button("Open Folder");
                    if open_btn.clicked() {
                        self.open_folder_dialog(ctx);
                    }

                    let open_archive_btn = ui.button("Open Archive");
                    if open_archive_btn.clicked() {
                        self.open_archive_dialog(ctx);
                    }

                    ui.separator();
                    ui.selectable_value(&mut self.view_mode, ViewMode::Scroll, "Scroll");
                    ui.selectable_value(&mut self.view_mode, ViewMode::SinglePage, "Single Page");
                    ui.separator();

                    if self.view_mode == ViewMode::SinglePage && !self.images.is_empty() {
                        ui.label(format!(
                            "Page {} / {}",
                            self.current_page + 1,
                            self.images.len()
                        ));
                        if ui.button("Prev").clicked() && self.current_page > 0 {
                            self.current_page -= 1;
                        }
                        if ui.button("Next").clicked() && self.current_page + 1 < self.images.len()
                        {
                            self.current_page += 1;
                        }
                        ui.separator();
                    } else {
                        ui.label(format!("{} images", self.images.len()));
                    }

                    let close_btn = ui.button("Close");
                    if close_btn.clicked() {
                        self.images.clear();
                        self.folder_path = None;
                        self.image_width = 0.0;
                        self.image_height = 0.0;
                        self._temp_dir = None;
                        self.current_page = 0;
                        self.app_title = None;
                        ctx.send_viewport_cmd(egui::ViewportCommand::Title("Manga Reader".to_string()));
                    }

                    if self.loading {
                        ui.label(" (Loading...)");
                    }
                });

                ui.separator();

                if self.view_mode == ViewMode::Scroll {
                    egui::ScrollArea::vertical()
                        .auto_shrink([false; 2])
                        .stick_to_bottom(false)
                        .wheel_scroll_multiplier(egui::vec2(3.0, 3.0)) // Increased scroll amplitude
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
                                let uri = format!("file://{}", image_data.path.to_string_lossy());
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

                                    let img_response = ui.add(
                                        egui::Image::new(&uri)
                                            .fit_to_exact_size(egui::vec2(final_w, final_h)),
                                    );

                                    // Draw the page number over the image at the bottom right
                                    let painter = ui.painter();
                                    let rect = img_response.rect;

                                    let text = format!("{}/{}", index + 1, total_images);
                                    let font_id = egui::FontId::proportional(16.0);
                                    let text_color = egui::Color32::WHITE;
                                    let bg_color = egui::Color32::from_black_alpha(160);

                                    let galley = painter.layout_no_wrap(text, font_id, text_color);

                                    let margin = egui::vec2(8.0, 4.0);
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

                                    ui.add_space(4.0);
                                });
                            }
                        });
                } else {
                    let available_height = ui.available_height();
                    egui::ScrollArea::vertical()
                        .auto_shrink([false; 2])
                        .stick_to_bottom(false)
                        .wheel_scroll_multiplier(egui::vec2(3.0, 3.0))
                        .show(ui, |ui| {
                            if scroll_delta != 0.0 {
                                ui.scroll_with_delta(egui::vec2(0.0, scroll_delta));
                            }

                            if self.current_page < self.images.len() {
                                let image_data = &self.images[self.current_page];
                                let uri = format!("file://{}", image_data.path.to_string_lossy());

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

                                    // Fit to screen height ideally for single page
                                    let scale_w = display_width / w;
                                    let scale_h = available_height / h;
                                    // But let's allow it to be larger if the user wants, or fit entirely
                                    let scale = scale_w.min(scale_h).min(1.0);
                                    let final_w = w * scale;
                                    let final_h = h * scale;

                                    if final_h < available_height - 1.0 {
                                        let padding = (available_height - final_h) / 2.0;
                                        ui.add_space(padding);
                                    }

                                    let img_response = ui.add(
                                        egui::Image::new(&uri)
                                            .fit_to_exact_size(egui::vec2(final_w, final_h))
                                            .sense(egui::Sense::click()),
                                    );

                                    if img_response.clicked() {
                                        if let Some(pos) = img_response.interact_pointer_pos() {
                                            if pos.x > img_response.rect.center().x {
                                                if self.current_page + 1 < self.images.len() {
                                                    self.current_page += 1;
                                                }
                                            } else {
                                                if self.current_page > 0 {
                                                    self.current_page -= 1;
                                                }
                                            }
                                        }
                                    }

                                    let painter = ui.painter();
                                    let rect = img_response.rect;

                                    let text = format!("{}/{}", self.current_page + 1, self.images.len());
                                    let font_id = egui::FontId::proportional(16.0);
                                    let text_color = egui::Color32::WHITE;
                                    let bg_color = egui::Color32::from_black_alpha(160);

                                    let galley = painter.layout_no_wrap(text, font_id, text_color);

                                    let margin = egui::vec2(8.0, 4.0);
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
                            }
                        });
                }
            }
        });

        if self.loading {
            ctx.request_repaint();
        }
    }
}

fn main() -> eframe::Result<()> {
    let args: Vec<String> = env::args().collect();
    let mut app = MangaReaderApp::default();

    if let Some(path_str) = args.get(1) {
        app.open_path(Path::new(path_str), None);
    }

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_app_id("manga_reader_app") // Explicit app_id for persistence feature to save/restore window bounds
            .with_inner_size([1000.0, 700.0])
            .with_min_inner_size([400.0, 300.0])
            .with_title(app.app_title.as_ref().map(|t| format!("Manga Reader - {}", t)).unwrap_or_else(|| "Manga Reader".to_string())),
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
            }
            Ok(Box::new(app))
        }),
    )
}
