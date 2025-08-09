import MeldEncrypt from "../../main.ts";
import { IMeldEncryptPluginFeature } from "../IMeldEncryptPluginFeature.ts";
import { IMeldEncryptPluginSettings } from "../../settings/MeldEncryptPluginSettings.ts";
import { Notice, TAbstractFile, TFile, TFolder, TextFileView } from "obsidian";
import PluginPasswordModal from "../../PluginPasswordModal.ts";
import { PasswordAndHint, SessionPasswordService } from "../../services/SessionPasswordService.ts";
import { FileDataHelper, JsonFileEncoding } from "../../services/FileDataHelper.ts";
import { ENCRYPTED_FILE_EXTENSIONS, ENCRYPTED_FILE_EXTENSION_DEFAULT } from "../../services/Constants.ts";
import { Utils } from "../../services/Utils.ts";
import { EncryptedMarkdownView } from "../feature-whole-note-encrypt/EncryptedMarkdownView.ts";

export default class FeatureFolderEncrypt implements IMeldEncryptPluginFeature {

  plugin: MeldEncrypt;

  async onload(plugin: MeldEncrypt, _settings: IMeldEncryptPluginSettings): Promise<void> {
    this.plugin = plugin;

    // Add context menu items to folders
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFolder)) {
          return;
        }

        menu.addItem((item) => {
          item
            .setTitle("Encrypt folder")
            .setIcon("folder-lock")
            .onClick(async () => await this.processEncryptFolder(file));
        });

        menu.addItem((item) => {
          item
            .setTitle("Decrypt folder")
            .setIcon("folder-lock-open")
            .onClick(async () => await this.processDecryptFolder(file));
        });
      })
    );
  }

  onunload(): void {}

  buildSettingsUi(): void {}

  private getFilesRecursively(folder: TFolder): TFile[] {
    const allFiles = this.plugin.app.vault.getFiles();
    const prefix = folder.path.length > 0 ? folder.path + "/" : "";
    return allFiles.filter((f) => f.path.startsWith(prefix));
  }

  private getMarkdownFiles(folder: TFolder): TFile[] {
    return this.getFilesRecursively(folder).filter((f) => f.extension === "md");
  }

  private getEncryptedFiles(folder: TFolder): TFile[] {
    return this.getFilesRecursively(folder).filter((f) => ENCRYPTED_FILE_EXTENSIONS.includes(f.extension));
  }

  private async promptPasswordForFolder(
    title: string,
    isEncrypting: boolean,
    defaultPath: string
  ): Promise<PasswordAndHint | null> {
    let pwh: PasswordAndHint | undefined;

    if (SessionPasswordService.getLevel() === SessionPasswordService.LevelExternalFile) {
      pwh = await SessionPasswordService.getByPathAsync(defaultPath);
    } else {
      pwh = await SessionPasswordService.getByPathAsync(defaultPath);
      if (pwh.password === "") {
        try {
          pwh = await new PluginPasswordModal(
            this.plugin.app,
            title,
            isEncrypting,
            /*confirmPassword*/ isEncrypting,
            pwh
          ).openAsync();
        } catch (e) {
          return null; // cancelled
        }
      }
    }

    return pwh ?? null;
  }

  private async processEncryptFolder(folder: TFolder): Promise<void> {
    const files = this.getMarkdownFiles(folder);
    if (files.length === 0) {
      new Notice("No markdown files to encrypt in this folder.");
      return;
    }

    const pwh = await this.promptPasswordForFolder(
      `Encrypt Folder "${folder.name}"`,
      true,
      folder.path
    );
    if (!pwh) {
      return;
    }

    let ok = 0;
    let fail = 0;

    for (const file of files) {
      try {
        const encryptedContent = await this.encryptFile(file, pwh);
        await this.closeUpdateRememberPasswordThenReopen(file, ENCRYPTED_FILE_EXTENSION_DEFAULT, encryptedContent, pwh);
        ok++;
      } catch (err) {
        console.error("Failed to encrypt", { file: file.path, err });
        fail++;
      }
    }

    new Notice(`Folder encrypted: ${ok} ok, ${fail} failed`);
  }

  private async processDecryptFolder(folder: TFolder): Promise<void> {
    const files = this.getEncryptedFiles(folder);
    if (files.length === 0) {
      new Notice("No encrypted files to decrypt in this folder.");
      return;
    }

    // Try to get password once; apply to all
    const pwh = await this.promptPasswordForFolder(
      `Decrypt Folder "${folder.name}"`,
      false,
      folder.path
    );
    if (!pwh) {
      return;
    }

    let ok = 0;
    let fail = 0;

    for (const file of files) {
      try {
        const decryptedContent = await this.decryptFile(file, pwh.password);
        if (decryptedContent == null) {
          throw new Error("Decryption failed");
        }
        await this.closeUpdateRememberPasswordThenReopen(file, "md", decryptedContent, pwh);
        ok++;
      } catch (err) {
        console.error("Failed to decrypt", { file: file.path, err });
        fail++;
      }
    }

    new Notice(`Folder decrypted: ${ok} ok, ${fail} failed`);
  }

  private async closeUpdateRememberPasswordThenReopen(
    file: TFile,
    newFileExtension: string,
    content: string,
    pw: PasswordAndHint
  ) {
    let didDetach = false;

    this.plugin.app.workspace.iterateAllLeaves((l) => {
      if (l.view instanceof TextFileView && (l.view.file as TAbstractFile) === file) {
        if (l.view instanceof EncryptedMarkdownView) {
          l.view.detachSafely();
        } else {
          l.detach();
        }
        didDetach = true;
      }
    });

    try {
      const newFilepath = Utils.getFilePathWithNewExtension(file, newFileExtension);
      await this.plugin.app.fileManager.renameFile(file, newFilepath);
      await this.plugin.app.vault.modify(file, content);
      SessionPasswordService.putByFile(pw, file);
    } finally {
      if (didDetach) {
        await this.plugin.app.workspace.getLeaf(true).openFile(file);
      }
    }
  }

  private async encryptFile(file: TFile, passwordAndHint: PasswordAndHint): Promise<string> {
    const content = await this.plugin.app.vault.read(file);
    const encryptedData = await FileDataHelper.encrypt(
      passwordAndHint.password,
      passwordAndHint.hint,
      content
    );
    return JsonFileEncoding.encode(encryptedData);
  }

  private async decryptFile(file: TFile, password: string): Promise<string | null> {
    const encryptedFileContent = await this.plugin.app.vault.read(file);
    const encryptedData = JsonFileEncoding.decode(encryptedFileContent);
    return await FileDataHelper.decrypt(encryptedData, password);
  }
}

