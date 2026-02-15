import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

let appFolders = {};
let gettextFn = text => text;
let originalDashGetAppFromSource = null;
let originalDashGetAppFromSourceDescriptor = null;
let dashGetAppFromSourcePatchMode = null;
const DASH_TO_DOCK_UUID = 'dash-to-dock@micxgx.gmail.com';
const APP_FOLDERS_SCHEMA_ID = 'org.gnome.desktop.app-folders';
const APP_FOLDERS_BASE_PATH = '/org/gnome/desktop/app-folders/';
const originalCreateAppItemKey = Symbol('originalCreateAppItem');
let createAppItemPatchTargets = new Set();
let extensionStateChangedSignalId = 0;
let appFoldersSettings = null;
let fallbackFolderParentView = null;

function getOverviewControls() {
    return Main.overview?._overview?._controls ?? null;
}

function getAppDisplay() {
    return getOverviewControls()?._appDisplay ?? null;
}

function getAppFoldersSettings() {
    if (!appFoldersSettings) {
        appFoldersSettings = new Gio.Settings({
            schema_id: APP_FOLDERS_SCHEMA_ID,
        });
    }
    return appFoldersSettings;
}

function getFolderChildren() {
    return getAppFoldersSettings().get_strv('folder-children');
}

function getFolderSettingsPath(id) {
    let basePath = getAppFoldersSettings().path ?? APP_FOLDERS_BASE_PATH;
    return `${basePath}folders/${id}/`;
}

function getFallbackFolderParentView() {
    if (!fallbackFolderParentView) {
        fallbackFolderParentView = {
            getAppInfos() {
                return Shell.AppSystem.get_default().get_installed();
            },
            addFolderDialog(dialog) {
                if (!dialog.get_parent?.()) {
                    if (Main.uiGroup.add_actor)
                        Main.uiGroup.add_actor(dialog);
                    else
                        Main.uiGroup.add_child(dialog);
                }
            },
        };
    }
    return fallbackFolderParentView;
}

function getFolderParentView() {
    return getAppDisplay() ?? getFallbackFolderParentView();
}

function lookupAppFolder(id) {
    if (!appFolders[id]) {
        appFolders[id] = new String(id);
        appFolders[id].is_window_backed = () => false;
        appFolders[id].get_id = () => id;
    }
    return appFolders[id];
}

function isFolderFavoriteApp(app) {
    return typeof app === 'string' || app instanceof String;
}

function getDashToDockManager() {
    let extension = Main.extensionManager?.lookup?.(DASH_TO_DOCK_UUID);
    return extension?.module?.dockManager ?? null;
}

function patchCreateAppItemTarget(target) {
    if (!target || typeof target._createAppItem !== 'function')
        return;

    if (target._createAppItem === createAppItem || createAppItemPatchTargets.has(target))
        return;

    target[originalCreateAppItemKey] = target._createAppItem;
    target._createAppItem = createAppItem;
    createAppItemPatchTargets.add(target);
}

function patchDashCreateAppItems() {
    patchCreateAppItemTarget(Dash.Dash.prototype);
    patchCreateAppItemTarget(getOverviewControls()?.dash?.constructor?.prototype);

    let docks = getDashToDockManager()?._allDocks ?? [];
    docks.forEach(dock => {
        patchCreateAppItemTarget(dock?.dash?.constructor?.prototype);
    });
}

function restoreCreateAppItemPatches() {
    createAppItemPatchTargets.forEach(target => {
        if (target._createAppItem === createAppItem &&
            typeof target[originalCreateAppItemKey] === 'function')
            target._createAppItem = target[originalCreateAppItemKey];
        delete target[originalCreateAppItemKey];
    });
    createAppItemPatchTargets.clear();
}

function ensurePlaceholder(source) {
    if (source instanceof AppDisplay.AppIcon) {
        this._originalEnsurePlaceholder.call(this, source);
        return;
    }

    if (this._placeholder)
        return;

    let id = source.id;
    let path = `${this._folderSettings.path}folders/${id}/`;
    this._placeholder = new AppDisplay.FolderIcon(id, path, this);
    this._placeholder.connect('notify::pressed', icon => {
        if (icon.pressed)
            this.updateDragFocus(icon);
    });
    this._placeholder.scaleAndFade();
    this._redisplay();
}

function loadApps() {
    let appIcons = this._originalLoadApps.call(this);
    let appFavorites = AppFavorites.getAppFavorites();
    let filteredFolderIcons = this._folderIcons.filter(icon => !appFavorites.isFavorite(icon._id));

    this._folderIcons.forEach(icon => {
        if (appFavorites.isFavorite(icon._id)) {
            appIcons.splice(appIcons.indexOf(icon), 1);
            icon.destroy();
        }
    });

    this._folderIcons = filteredFolderIcons;
    return appIcons;
}

function initFolderIcon(id, path, parentView) {
    this._originalInitFolderIcon.call(this, id, path, parentView);
    this.app = lookupAppFolder(id);

    this.connect('button-press-event', (_actor, event) => {
        if (event.get_button() === 3) {
            popupMenu.call(this);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    });

    this._menuManager = new PopupMenu.PopupMenuManager(this);
}

function popupMenu() {
    this.setForcedHighlight(true);
    this.fake_release();

    if (!this._menu) {
        let appFavorites = AppFavorites.getAppFavorites();
        let isFavorite = appFavorites.isFavorite(this._id);
        let side = isFavorite ? St.Side.BOTTOM : St.Side.LEFT;
        let label = isFavorite ? gettextFn('Unpin') : gettextFn('Pin to Dash');

        this._menu = new PopupMenu.PopupMenu(this, 0.5, side);
        this._menu.addAction(label, () => {
            if (isFavorite)
                appFavorites.removeFavorite(this._id);
            else
                appFavorites.addFavorite(this._id);
        });

        this._menu.connect('open-state-changed', (_menu, isPoppedUp) => {
            if (!isPoppedUp)
                this.setForcedHighlight(false);
        });

        Main.overview.connectObject('hiding', () => {
            this._menu.close();
        }, this);

        if (Main.uiGroup.add_actor)
            Main.uiGroup.add_actor(this._menu.actor);
        else
            Main.uiGroup.add_child(this._menu.actor);

        this._menuManager.addMenu(this._menu);
    }

    this._menu.open(BoxPointer.PopupAnimation.FULL);
    this._menuManager.ignoreRelease();

    let item = this.get_parent();
    if (item instanceof Dash.DashItemContainer) {
        let controls = getOverviewControls();
        controls?.dash?._syncLabel(item, this);
    }
}

function updateName() {
    let item = this.get_parent();
    if (item instanceof Dash.DashItemContainer) {
        this._name = AppDisplay._getFolderName(this._folder);
        item.setLabelText(this._name);
    } else {
        this._originalUpdateName.call(this);
    }
}

function reload() {
    this._originalReload.call(this);

    let folders = getFolderChildren();
    let ids = global.settings.get_strv(this.FAVORITE_APPS_KEY);
    this._favorites = {};

    ids.forEach(id => {
        let app = Shell.AppSystem.get_default().lookup_app(id);
        if (app !== null && this._parentalControlsManager.shouldShowApp(app.app_info))
            this._favorites[app.get_id()] = app;
        else if (folders.includes(id))
            this._favorites[id] = lookupAppFolder(id);
    });
}

function addFavorite(appId, pos) {
    let folders = getFolderChildren();

    if (!folders.includes(appId))
        return this._originalAddFavorite.call(this, appId, pos);

    if (appId in this._favorites)
        return false;

    let ids = this._getIds();
    ids.splice(pos === -1 ? ids.length : pos, 0, appId);
    global.settings.set_strv(this.FAVORITE_APPS_KEY, ids);
    return true;
}

function addFavoriteAtPos(appId, pos) {
    let folders = getFolderChildren();

    if (!folders.includes(appId)) {
        this._originalAddFavoriteAtPos.call(this, appId, pos);
        return;
    }

    if (!this._addFavorite(appId, pos))
        return;

    let path = getFolderSettingsPath(appId);
    let folder = new Gio.Settings({
        schema_id: 'org.gnome.desktop.app-folders.folder',
        path,
    });

    let folderName = AppDisplay._getFolderName(folder);
    let msg = gettextFn('%s has been pinned to the dash.').format(folderName);
    Main.overview.setMessage(msg, {
        forFeedback: true,
        undoCallback: () => this._removeFavorite(appId),
    });
}

function removeFavorite(appId) {
    let folders = getFolderChildren();

    if (!folders.includes(appId)) {
        this._originalRemoveFavorite.call(this, appId);
        return;
    }

    let pos = this._getIds().indexOf(appId);
    if (!this._removeFavorite(appId))
        return;

    let path = getFolderSettingsPath(appId);
    let folder = new Gio.Settings({
        schema_id: 'org.gnome.desktop.app-folders.folder',
        path,
    });

    let folderName = AppDisplay._getFolderName(folder);
    let msg = gettextFn('%s has been unpinned from the dash.').format(folderName);
    Main.overview.setMessage(msg, {
        forFeedback: true,
        undoCallback: () => this._addFavorite(appId, pos),
    });
}

function getAppFromSource(source) {
    if (source instanceof AppDisplay.FolderIcon)
        return source.app;

    if (typeof originalDashGetAppFromSource === 'function')
        return originalDashGetAppFromSource.call(Dash, source);

    return source?.app ?? null;
}

function createAppItem(app) {
    let originalCreateAppItem = this[originalCreateAppItemKey];
    if (typeof originalCreateAppItem !== 'function')
        throw new Error('Missing original _createAppItem implementation');

    if (!isFolderFavoriteApp(app))
        return originalCreateAppItem.call(this, app);

    let id = app.toString();
    let path = getFolderSettingsPath(id);
    let appIcon = new AppDisplay.FolderIcon(id, path, getFolderParentView());

    appIcon.connect('apps-changed', () => {
        let appDisplay = getAppDisplay();
        appDisplay?._redisplay();
        appDisplay?._savePages();
        appIcon.view._redisplay();
    });

    // Dash-to-Dock expects these methods on every icon it tracks.
    appIcon.setNumberOverlay ??= () => {};
    appIcon.updateNumberOverlay ??= () => {};
    appIcon.toggleNumberOverlay ??= () => {};
    appIcon.updateIconGeometry ??= () => {};

    let item = new Dash.DashItemContainer();

    item.setChild(appIcon);
    appIcon.icon.style_class = 'overview-icon';
    if (appIcon.icon._box.remove_actor)
        appIcon.icon._box.remove_actor(appIcon.icon.label);
    else
        appIcon.icon._box.remove_child(appIcon.icon.label);

    appIcon.label_actor = null;
    appIcon.icon.label = null;
    item.setLabelText(AppDisplay._getFolderName(appIcon._folder));
    appIcon.icon.setIconSize(this.iconSize);
    appIcon.icon.y_align = Clutter.ActorAlign.CENTER;
    appIcon.shouldShowTooltip = () => appIcon.hover && (!appIcon._menu || !appIcon._menu.isOpen);
    this._hookUpLabel(item);

    return item;
}

function redisplayIcons() {
    AppFavorites.getAppFavorites().reload();

    let controls = getOverviewControls();
    let appDisplay = controls?._appDisplay;
    if (appDisplay) {
        let apps = appDisplay._orderedItems.slice();
        apps.forEach(icon => {
            appDisplay._removeItem(icon);
        });
        appDisplay._redisplay();
    }

    controls?.dash?._queueRedisplay?.();
    let docks = getDashToDockManager()?._allDocks ?? [];
    docks.forEach(dock => {
        dock?.dash?._queueRedisplay?.();
    });
}

export default class PinAppFoldersToDashExtension extends Extension {
    enable() {
        gettextFn = this.gettext.bind(this);
        appFolders = {};
        appFoldersSettings = null;
        fallbackFolderParentView = null;
        createAppItemPatchTargets = new Set();

        let appDisplayProto = AppDisplay.AppDisplay.prototype;
        appDisplayProto._originalEnsurePlaceholder = appDisplayProto._ensurePlaceholder;
        appDisplayProto._ensurePlaceholder = ensurePlaceholder;
        appDisplayProto._originalLoadApps = appDisplayProto._loadApps;
        appDisplayProto._loadApps = loadApps;

        let folderIconProto = AppDisplay.FolderIcon.prototype;
        folderIconProto._originalInitFolderIcon = folderIconProto._init;
        folderIconProto._init = initFolderIcon;
        folderIconProto._originalUpdateName = folderIconProto._updateName;
        folderIconProto._updateName = updateName;

        let appFavoritesProto = AppFavorites.getAppFavorites().constructor.prototype;
        appFavoritesProto._originalAddFavorite = appFavoritesProto._addFavorite;
        appFavoritesProto._addFavorite = addFavorite;
        appFavoritesProto._originalAddFavoriteAtPos = appFavoritesProto.addFavoriteAtPos;
        appFavoritesProto.addFavoriteAtPos = addFavoriteAtPos;
        appFavoritesProto._originalRemoveFavorite = appFavoritesProto.removeFavorite;
        appFavoritesProto.removeFavorite = removeFavorite;
        appFavoritesProto._originalReload = appFavoritesProto.reload;
        appFavoritesProto.reload = reload;

        originalDashGetAppFromSourceDescriptor = Object.getOwnPropertyDescriptor(Dash, 'getAppFromSource') ?? null;
        originalDashGetAppFromSource = originalDashGetAppFromSourceDescriptor?.value ?? Dash.getAppFromSource;
        dashGetAppFromSourcePatchMode = null;
        try {
            if (originalDashGetAppFromSourceDescriptor?.configurable) {
                let getAppFromSourceDescriptor = {
                    ...originalDashGetAppFromSourceDescriptor,
                    value: getAppFromSource,
                };
                Object.defineProperty(Dash, 'getAppFromSource', getAppFromSourceDescriptor);
                dashGetAppFromSourcePatchMode = 'define';
            } else if (originalDashGetAppFromSourceDescriptor?.writable) {
                Dash.getAppFromSource = getAppFromSource;
                dashGetAppFromSourcePatchMode = 'assign';
            } else if (!originalDashGetAppFromSourceDescriptor && Object.isExtensible(Dash)) {
                Object.defineProperty(Dash, 'getAppFromSource', {
                    value: getAppFromSource,
                    writable: true,
                    configurable: true,
                });
                dashGetAppFromSourcePatchMode = 'define';
            }
        } catch (_error) {
            dashGetAppFromSourcePatchMode = null;
        }

        patchDashCreateAppItems();
        extensionStateChangedSignalId = Main.extensionManager.connect('extension-state-changed',
            (_manager, extension) => {
                if (extension?.uuid === DASH_TO_DOCK_UUID)
                    patchDashCreateAppItems();
            });

        redisplayIcons();
    }

    disable() {
        let appDisplayProto = AppDisplay.AppDisplay.prototype;
        appDisplayProto._ensurePlaceholder = appDisplayProto._originalEnsurePlaceholder;
        appDisplayProto._loadApps = appDisplayProto._originalLoadApps;

        let folderIconProto = AppDisplay.FolderIcon.prototype;
        folderIconProto._init = folderIconProto._originalInitFolderIcon;
        folderIconProto._updateName = folderIconProto._originalUpdateName;

        let appFavoritesProto = AppFavorites.getAppFavorites().constructor.prototype;
        appFavoritesProto._addFavorite = appFavoritesProto._originalAddFavorite;
        appFavoritesProto.addFavoriteAtPos = appFavoritesProto._originalAddFavoriteAtPos;
        appFavoritesProto.removeFavorite = appFavoritesProto._originalRemoveFavorite;
        appFavoritesProto.reload = appFavoritesProto._originalReload;

        if (dashGetAppFromSourcePatchMode === 'define') {
            if (originalDashGetAppFromSourceDescriptor)
                Object.defineProperty(Dash, 'getAppFromSource', originalDashGetAppFromSourceDescriptor);
            else
                delete Dash.getAppFromSource;
        } else if (dashGetAppFromSourcePatchMode === 'assign') {
            Dash.getAppFromSource = originalDashGetAppFromSource;
        }
        originalDashGetAppFromSource = null;
        originalDashGetAppFromSourceDescriptor = null;
        dashGetAppFromSourcePatchMode = null;

        if (extensionStateChangedSignalId) {
            Main.extensionManager.disconnect(extensionStateChangedSignalId);
            extensionStateChangedSignalId = 0;
        }
        restoreCreateAppItemPatches();

        redisplayIcons();
        gettextFn = text => text;
        appFolders = {};
        appFoldersSettings = null;
        fallbackFolderParentView = null;
    }
}
