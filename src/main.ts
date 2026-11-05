import {
	App,
	debounce,
	FuzzySuggestModal,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
} from "obsidian";
import { hasConflictMarkers } from "./merge";
import qrcode from "qrcode-generator";
import { authorizeDesktop, exportConnection, importConnection } from "./auth";
import { Credentials, DriveClient } from "./drive";
import { SyncEngine, SyncResult, SyncState } from "./sync";

interface Settings {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
	folderName: string;
	deviceName: string;
	autoSyncMinutes: number;
	syncOnStartup: boolean;
	syncAfterEdit: boolean;
	syncOnResume: boolean;
	excludes: string;
	showNotices: boolean;
}

interface PluginData {
	settings: Settings;
	state: SyncState;
}

function defaultDeviceName(): string {
	if (Platform.isDesktopApp) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			return (require("os") as typeof import("os")).hostname();
		} catch {
			return "Computer";
		}
	}
	if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
	if (Platform.isAndroidApp) return Platform.isTablet ? "Android-Tablet" : "Android-Handy";
	return "Gerät";
}

export default class DriveSyncPlugin extends Plugin {
	settings!: Settings;
	state!: SyncState;
	drive!: DriveClient;
	engine!: SyncEngine;

	private syncing = false;
	private pending = false;
	private lastSync = 0;
	private lastError = "";
	private statusEl!: HTMLElement;
	private intervalId: number | null = null;

	async onload() {
		await this.loadAll();

		this.drive = new DriveClient(() => ({
			clientId: this.settings.clientId,
			clientSecret: this.settings.clientSecret,
			refreshToken: this.settings.refreshToken,
		}));
		this.engine = new SyncEngine(
			this.app,
			this.drive,
			this.state,
			() => ({
				folderName: this.settings.folderName,
				deviceName: this.settings.deviceName,
				excludes: this.settings.excludes.split("\n"),
			}),
			`${this.app.vault.configDir}/plugins/${this.manifest.id}/base`,
			() => this.saveAll()
		);

		this.addRibbonIcon("refresh-cw", "Mit Google Drive synchronisieren", () => this.sync(true));
		this.addCommand({
			id: "sync-now",
			name: "Jetzt mit Google Drive synchronisieren",
			callback: () => this.sync(true),
		});

		this.addCommand({
			id: "show-conflicts",
			name: "Notizen mit Sync-Konflikten anzeigen",
			callback: () => this.showConflicts(),
		});

		// QR code / link from another device: obsidian://gdrive-vault-sync?code=ODS1:…
		this.registerObsidianProtocolHandler(LINK_ACTION, (params) => {
			if (params.code) void this.connectWithCode(params.code);
		});

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("mod-clickable");
		this.statusEl.onClickEvent(() => this.sync(true));
		this.registerInterval(window.setInterval(() => this.renderStatus(), 30_000));
		this.renderStatus();

		this.addSettingTab(new DriveSyncSettingTab(this.app, this));

		// Sync shortly after edits stop (keeps devices close together -> fewer conflicts).
		const afterEdit = debounce(() => this.sync(false), 10_000, true);
		const onChange = (f: TAbstractFile) => {
			if (!this.settings.syncAfterEdit || this.syncing) return;
			if (f.path.startsWith(this.app.vault.configDir + "/")) return;
			afterEdit();
		};
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.vault.on("modify", onChange));
			this.registerEvent(this.app.vault.on("create", onChange));
			this.registerEvent(this.app.vault.on("delete", onChange));
			this.registerEvent(this.app.vault.on("rename", onChange));
			if (this.settings.syncOnStartup) window.setTimeout(() => this.sync(false), 1500);
		});

		// Phones/tablets: sync when the app comes back to the foreground.
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible" && this.settings.syncOnResume) {
				if (Date.now() - this.lastSync > 20_000) this.sync(false);
			}
		});

		this.restartInterval();
	}

	restartInterval() {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		this.intervalId = null;
		const minutes = this.settings.autoSyncMinutes;
		if (minutes > 0) {
			this.intervalId = window.setInterval(() => this.sync(false), minutes * 60_000);
			this.registerInterval(this.intervalId);
		}
	}

	isConnected() {
		return !!(this.settings.clientId && this.settings.refreshToken);
	}

	async sync(manual: boolean) {
		if (!this.isConnected()) {
			if (manual) new Notice("Google Drive Sync: Bitte zuerst in den Einstellungen verbinden.");
			return;
		}
		if (this.syncing) {
			this.pending = true;
			return;
		}
		this.syncing = true;
		const progress = manual ? new Notice("Synchronisiere …", 0) : null;
		try {
			const result = await this.engine.run((msg) => {
				this.statusEl.setText(`☁ ${msg}`);
				progress?.setMessage(msg);
			});
			this.lastSync = Date.now();
			this.lastError = result.errors[0] ?? "";
			this.report(result, manual);
		} catch (e) {
			this.lastError = (e as Error).message;
			new Notice(`Google Drive Sync: ${this.lastError}`, 8000);
		} finally {
			progress?.hide();
			this.syncing = false;
			this.renderStatus();
			if (this.pending) {
				this.pending = false;
				window.setTimeout(() => this.sync(false), 1000);
			}
		}
	}

	private report(r: SyncResult, manual: boolean) {
		const parts: string[] = [];
		if (r.uploaded) parts.push(`↑ ${r.uploaded}`);
		if (r.downloaded) parts.push(`↓ ${r.downloaded}`);
		if (r.deleted) parts.push(`🗑 ${r.deleted}`);
		if (r.merged) parts.push(`${r.merged} zusammengeführt`);
		if (r.marked.length) {
			const n = new Notice(
				`Google Drive Sync: In ${r.marked.length} Notiz(en) wurde dieselbe Stelle auf zwei Geräten geändert. ` +
					`Beide Versionen sind in der Notiz markiert (⚠ Sync-Konflikt):\n` +
					r.marked.join("\n") +
					"\n\nKlicken zum Öffnen.",
				20000
			);
			n.noticeEl.addEventListener("click", () => this.openNote(r.marked[0]));
		}
		if (r.conflicts.length) {
			new Notice(
				`Google Drive Sync: ${r.conflicts.length} Konflikt(e). Die ältere Version der Datei wurde gespeichert als:\n` +
					r.conflicts.join("\n"),
				15000
			);
		}
		if (r.errors.length) {
			console.error("[Google Drive Sync]", r.errors);
			new Notice(`Google Drive Sync: ${r.errors.length} Fehler – ${r.errors[0]}`, 10000);
		}
		if (manual || (this.settings.showNotices && parts.length)) {
			new Notice(`Google Drive Sync: ${parts.length ? parts.join(" · ") : "Alles aktuell ✓"}`);
		}
	}

	connectionCode(): string {
		return exportConnection({
			clientId: this.settings.clientId,
			clientSecret: this.settings.clientSecret,
			refreshToken: this.settings.refreshToken,
		});
	}

	/**
	 * Takes over a connection code (pasted, or from a scanned QR code / tapped link).
	 * Always shows which Google account it belongs to and asks for confirmation,
	 * so a foreign link can never silently connect this vault to someone else's Drive.
	 */
	async connectWithCode(code: string, onDone?: () => void) {
		let creds: Credentials;
		try {
			creds = importConnection(code);
		} catch (e) {
			new Notice((e as Error).message);
			return;
		}
		if (creds.refreshToken === this.settings.refreshToken) {
			new Notice("Dieses Gerät ist bereits mit diesem Code verbunden ✓");
			return;
		}
		let email = "";
		try {
			email = await new DriveClient(() => creds).accountEmail();
		} catch (e) {
			new Notice(`Der Verbindungscode funktioniert nicht: ${(e as Error).message}`, 10000);
			return;
		}
		new ConfirmConnectModal(this.app, email, async () => {
			Object.assign(this.settings, creds);
			await this.saveAll();
			new Notice(`Mit Google Drive verbunden ✓ (${email})`);
			this.renderStatus();
			onDone?.();
			void this.sync(true);
		}).open();
	}

	async openNote(path: string) {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) await this.app.workspace.getLeaf(false).openFile(f);
	}

	async showConflicts() {
		const files: TFile[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (hasConflictMarkers(await this.app.vault.cachedRead(f))) files.push(f);
		}
		if (!files.length) {
			new Notice("Keine offenen Sync-Konflikte ✓");
			return;
		}
		new ConflictListModal(this.app, files, (f) => this.openNote(f.path)).open();
	}

	renderStatus() {
		if (!this.statusEl || this.syncing) return;
		if (!this.isConnected()) {
			this.statusEl.setText("☁ nicht verbunden");
			return;
		}
		if (this.lastError) {
			this.statusEl.setText("☁ ⚠ Fehler");
			this.statusEl.setAttr("aria-label", this.lastError);
			return;
		}
		if (!this.lastSync) {
			this.statusEl.setText("☁ bereit");
			return;
		}
		const min = Math.floor((Date.now() - this.lastSync) / 60_000);
		this.statusEl.setText(min < 1 ? "☁ ✓ gerade eben" : `☁ ✓ vor ${min} Min.`);
		this.statusEl.setAttr(
			"aria-label",
			`Klicken zum Synchronisieren · ${this.manifest.name} ${this.manifest.version}`
		);
	}

	async loadAll() {
		const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
		this.settings = Object.assign(
			{
				clientId: "",
				clientSecret: "",
				refreshToken: "",
				folderName: `Obsidian – ${this.app.vault.getName()}`,
				deviceName: defaultDeviceName(),
				autoSyncMinutes: 2,
				syncOnStartup: true,
				syncAfterEdit: true,
				syncOnResume: true,
				excludes: ".trash/**\n# Eigene Ausschlüsse, z. B.:\n# Privat/**\n# *.mp4",
				showNotices: false,
			},
			data.settings
		);
		this.state = Object.assign({ base: {}, cache: {}, folderId: "", folderName: "" }, data.state);
	}

	async saveAll() {
		await this.saveData({ settings: this.settings, state: this.state } satisfies PluginData);
	}
}

const LINK_ACTION = "gdrive-vault-sync";

class QrModal extends Modal {
	constructor(app: App, private code: string) {
		super(app);
	}
	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText("Weiteres Gerät verbinden");
		const link = `obsidian://${LINK_ACTION}?code=${encodeURIComponent(this.code)}`;
		const qr = qrcode(0, "L");
		qr.addData(link);
		qr.make();
		const svg = new DOMParser().parseFromString(
			qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true }),
			"image/svg+xml"
		).documentElement;
		svg.setAttribute("width", "100%");
		svg.removeAttribute("height");
		const box = contentEl.createDiv();
		box.setCssStyles({
			background: "#ffffff",
			padding: "12px",
			borderRadius: "8px",
			maxWidth: "340px",
			margin: "0 auto 12px",
		});
		box.appendChild(contentEl.doc.importNode(svg, true));

		const ol = contentEl.createEl("ol");
		ol.createEl("li", { text: "Auf dem Tablet/Handy Obsidian mit dem richtigen Vault öffnen – das Plugin muss dort installiert und aktiviert sein." });
		ol.createEl("li", { text: "Die Kamera-App öffnen und auf diesen QR-Code richten." });
		ol.createEl("li", { text: "Auf den eingeblendeten Hinweis „In Obsidian öffnen“ tippen und bestätigen." });
		contentEl.createEl("p", {
			cls: "mod-warning",
			text: "⚠ Der QR-Code enthält deinen Zugang. Keinen Screenshot teilen und das Fenster nach dem Scannen schließen.",
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}

class ConfirmConnectModal extends Modal {
	constructor(app: App, private email: string, private onConfirm: () => void | Promise<void>) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText("Mit Google Drive verbinden?");
		this.contentEl.createEl("p", {
			text: `Dieses Gerät wird mit dem Google-Konto ${this.email || "(unbekannt)"} verbunden. Deine Notizen werden in dessen Google Drive synchronisiert.`,
		});
		this.contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "Nur bestätigen, wenn das dein eigenes Konto ist und du den Code selbst erzeugt hast.",
		});
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Abbrechen").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Verbinden")
					.setCta()
					.onClick(async () => {
						this.close();
						await this.onConfirm();
					})
			);
	}
	onClose() {
		this.contentEl.empty();
	}
}

class ConflictListModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private files: TFile[], private choose: (f: TFile) => void) {
		super(app);
		this.setPlaceholder(`${files.length} Notiz(en) mit Sync-Konflikten – auswählen zum Öffnen`);
	}
	getItems() {
		return this.files;
	}
	getItemText(f: TFile) {
		return f.path;
	}
	onChooseItem(f: TFile) {
		this.choose(f);
	}
}

class DriveSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: DriveSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const p = this.plugin;
		const s = p.settings;
		containerEl.empty();

		// Header with the installed version
		const releases = "https://github.com/4ndr345geo/claude-obsidian-sync/releases";
		new Setting(containerEl)
			.setName(p.manifest.name)
			.setDesc(`Installierte Version: ${p.manifest.version}`)
			.addExtraButton((b) =>
				b
					.setIcon("external-link")
					.setTooltip("Alle Versionen und Änderungen auf GitHub")
					.onClick(() => window.open(releases))
			);

		containerEl.createEl("h3", { text: "Verbindung" });
		const status = containerEl.createDiv({ cls: "setting-item-description" });
		status.setText(
			p.isConnected()
				? `✓ Verbunden. Ordner in Google Drive: „${s.folderName}“`
				: "Nicht verbunden. Anleitung: siehe README des Plugins."
		);

		if (Platform.isDesktopApp) {
			new Setting(containerEl)
				.setName("OAuth Client-ID")
				.setDesc("Aus der Google Cloud Console (Typ „Desktop-App“).")
				.addText((t) =>
					t.setValue(s.clientId).onChange(async (v) => {
						s.clientId = v.trim();
						await p.saveAll();
					})
				);
			new Setting(containerEl).setName("OAuth Client-Secret").addText((t) => {
				t.inputEl.type = "password";
				t.setValue(s.clientSecret).onChange(async (v) => {
					s.clientSecret = v.trim();
					await p.saveAll();
				});
			});
			new Setting(containerEl)
				.setName(p.isConnected() ? "Neu verbinden" : "Mit Google Drive verbinden")
				.setDesc("Öffnet den Browser zur Google-Anmeldung.")
				.addButton((b) =>
					b
						.setButtonText("Verbinden")
						.setCta()
						.onClick(async () => {
							if (!s.clientId || !s.clientSecret) {
								new Notice("Bitte zuerst Client-ID und Client-Secret eintragen.");
								return;
							}
							try {
								s.refreshToken = await authorizeDesktop(s.clientId, s.clientSecret);
								await p.saveAll();
								new Notice("Mit Google Drive verbunden ✓");
								this.display();
								p.sync(true);
							} catch (e) {
								new Notice(`Verbindung fehlgeschlagen: ${(e as Error).message}`, 8000);
							}
						})
				);
		}

		if (p.isConnected()) {
			new Setting(containerEl)
				.setName("Weiteres Gerät verbinden")
				.setDesc(
					"QR-Code mit der Kamera von iPad/iPhone/Android scannen – oder den Code kopieren und dort einfügen. " +
						"Enthält deinen Zugang – nicht weitergeben!"
				)
				.addButton((b) =>
					b
						.setButtonText("QR-Code anzeigen")
						.setCta()
						.onClick(() => new QrModal(this.app, p.connectionCode()).open())
				)
				.addButton((b) =>
					b.setButtonText("Code kopieren").onClick(async () => {
						await navigator.clipboard.writeText(p.connectionCode());
						new Notice("Verbindungscode kopiert.");
					})
				);
		}

		let code = "";
		new Setting(containerEl)
			.setName("Verbindungscode einfügen")
			.setDesc(
				"Für Handy/Tablet. Einfacher: am Computer „QR-Code anzeigen“ wählen und mit der Kamera scannen."
			)
			.addText((t) => t.setPlaceholder("ODS1:…").onChange((v) => (code = v)))
			.addButton((b) =>
				b.setButtonText("Übernehmen").onClick(() => p.connectWithCode(code, () => this.display()))
			);

		if (p.isConnected()) {
			new Setting(containerEl).setName("Trennen").addButton((b) =>
				b
					.setButtonText("Verbindung trennen")
					.setWarning()
					.onClick(async () => {
						s.refreshToken = "";
						await p.saveAll();
						this.display();
						p.renderStatus();
					})
			);
		}

		containerEl.createEl("h3", { text: "Synchronisierung" });

		new Setting(containerEl)
			.setName("Ordnername in Google Drive")
			.setDesc("Muss auf allen Geräten gleich sein.")
			.addText((t) =>
				t.setValue(s.folderName).onChange(async (v) => {
					s.folderName = v.trim() || s.folderName;
					await p.saveAll();
				})
			);

		new Setting(containerEl)
			.setName("Gerätename")
			.setDesc("Erscheint im Namen von Konfliktkopien.")
			.addText((t) =>
				t.setValue(s.deviceName).onChange(async (v) => {
					s.deviceName = v.trim() || defaultDeviceName();
					await p.saveAll();
				})
			);

		new Setting(containerEl)
			.setName("Automatisch synchronisieren alle … Minuten")
			.setDesc("0 = aus")
			.addSlider((sl) =>
				sl
					.setLimits(0, 30, 1)
					.setValue(s.autoSyncMinutes)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.autoSyncMinutes = v;
						await p.saveAll();
						p.restartInterval();
					})
			);

		const toggle = (name: string, desc: string, key: "syncOnStartup" | "syncAfterEdit" | "syncOnResume" | "showNotices") =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((t) =>
					t.setValue(s[key]).onChange(async (v) => {
						s[key] = v;
						await p.saveAll();
					})
				);
		toggle("Beim Start synchronisieren", "Empfohlen.", "syncOnStartup");
		toggle("Nach dem Bearbeiten synchronisieren", "10 Sekunden nach der letzten Änderung. Empfohlen.", "syncAfterEdit");
		toggle("Beim Zurückkehren in die App synchronisieren", "Wichtig für Handy und Tablet.", "syncOnResume");
		toggle("Meldung bei jeder Synchronisierung", "Zeigt eine Meldung, wenn Dateien übertragen wurden.", "showNotices");

		new Setting(containerEl)
			.setName("Ausschließen")
			.setDesc("Ein Muster pro Zeile, z. B. „Privat/**“ oder „*.mp4“. Der Ordner .obsidian wird nie synchronisiert.")
			.addTextArea((t) => {
				t.inputEl.rows = 5;
				t.setValue(s.excludes).onChange(async (v) => {
					s.excludes = v;
					await p.saveAll();
				});
			});
	}
}
