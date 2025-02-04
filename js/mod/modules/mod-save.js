import { Patcher } from './patcher.js';
import { ModEvent } from './event/mod-event.js';

export const MAGINAI_SAVE_KEY = 'maginai';

/**
 * `maginai.modSave` submodule class
 *
 * Do not instantiate directly; use from `maginai.modSave`.
 *
 * You can read and write mod-specific data to the save data using `getSaveObject` / `setSaveObject`
 *
 * Use `getSaveObject(name)` to obtain the save object corresponding to the key `name` from the current save data.
 *
 * Use `setSaveObject(name, obj)` to set `obj` as a save object corresponding to the key `name`.
 *
 * Use `removeSaveObject(name)` to delete the save object corresponding to the key `name`.
 *
 * The changes made by `setSaveObject` and `removeSaveObject` will be written to the current save data the next time save operation is performed.
 *
 * Each of these methods throws an exception if no save data is loaded, such as on the title screen.
 *
 * There are two `maginai` events that work well with `maginai.modSave`: `saveLoaded` and `saveObjectRequired`.
 * The former is triggered right after the save data is loaded, and the latter is triggered right before the save data is written.
 * It is recommended to use `getSaveObject` and `setSaveObject` within your event handlers for those events.
 *
 * Example:
 * ```typescript
 * // `init.js` of `sample4` mod, which counts how many times you performed saving
 * (function () {
 *   const logger = maginai.logging.getLogger('sample4');
 *   // Variable for counting saving
 *   let saveCount;
 *   // Store the submodules in variables to reduce typing
 *   const sv = maginai.modSave;
 *   const ev = maginai.events;
 *
 *   // When the save data is loaded...
 *   ev.saveLoaded.addHandler(() => {
 *     // Use `getSaveObject` to get the save object for `sample4` from the current save data
 *     const saveObj = sv.getSaveObject('sample4');
 *     if (saveObj === undefined) {
 *       // If no save object for `sample4` exists, it returns undefined, so set the initial value of `saveCount` to 0
 *       saveCount = 0;
 *     } else {
 *       // If the save object exists, set `saveCount` from it
 *       saveCount = saveObj.saveCount;
 *     }
 *     // Log the `saveCount` loaded from the save
 *     logger.info(
 *       `Save object has been loaded. saveCount:` + saveCount.toString()
 *     );
 *   });
 *
 *   // Just before writing the save data...
 *   ev.saveObjectRequired.addHandler(() => {
 *     // Increment `saveCount` by 1
 *     saveCount += 1;
 *
 *     // Set an object that contains `saveCount` as the save object `sample4`
 *     sv.setSaveObject('sample4', { saveCount });
 *     logger.info(`Save has been set`);
 *   });
 * })();
 * ```
 *
 * Note:
 * - Since the same save object can be accessed with the same `name` from any mod, it is necessary to have a unique `name` that does not conflict (it is generally recommended to use the mod's name as `name`)
 * - Save objects are processed with `JSON.stringify` during the saving process, so objects that cannot be serialized as json, such as methods, will be removed
 * - The save capacity of the browser version of CoAW is about 5MB for two save slots. Therefore, if the save data becomes too large, saving may fail
 *   - Tips: If `tWgm.isL` is set to `true`, the save size will be logged to the dev console when a save operation is performed
 *
 */
export class ModSave {
  /**
   * @internal
   */
  constructor() {
    /**
     * @private
     * For saving the result of UnzipWorker (see `init()`)
     * @type {object | null}
     */
    this.previousUnzipWorkerResult = null;

    /**
     * @private
     * The root save object
     * `rootSaveObject['<name>']` contains the save object for `<name>`
     * @type {object}
     */
    this.rootSaveObject = {};

    /**
     * Whether save data is available
     */
    this.isSaveAvailable = false;

    /**
     * @internal
     * Event triggered when collecting save objects from each mod
     */
    this.saveObjectRequired = new ModEvent('saveObjectRequired');
  }

  /**
   * @internal
   * Initialization （`union.js` required）
   */
  init() {
    const patcher = new Patcher();
    const self = this;
    // tGameSave.unzipDataWorkerにパッチして、unzipした結果のデータを_previousUnzipWorkerResultにストアする
    // 結果はcallbackの引数に渡されるので、callbackを新しいものに差し替えてその中で結果を取得、ストアする
    // ※直接ロードされたセーブデータにアクセスできるメソッドへのパッチができないため、ここでUnzipの前結果を保存しておき
    // このあとtGameCharactorのsetSaveが呼ばれたらそのときUnzipの前結果==セーブデータオブジェクトとして扱う、という二段構えにしている
    patcher.patchMethod(tGameSave, 'unzipDataWorker', (origMethod) => {
      const rtnFn = function (a, callback, ...args) {
        const newCallback = (result, ...cbArgs) => {
          self.previousUnzipWorkerResult = result;
          const cbRtn = callback(result, ...cbArgs);
          return cbRtn;
        };
        return origMethod.call(this, a, newCallback, ...args);
      };
      return rtnFn;
    });

    // tGameMap.setSaveに"相乗り"してMod用セーブデータを取得するためパッチ
    // 二段構え構成でMod用セーブデータの取得を実現している(詳細は上記)
    // セーブデータ取得後、利用可能フラグをtrueにする
    patcher.patchMethod(tGameMap, 'setSaveData', (origMethod) => {
      const rtnFn = function (...args) {
        if (self.previousUnzipWorkerResult !== null) {
          // このsetSaveが呼ばれたときの_previousUnzipWorkerResultがunzipされて展開済のセーブデータオブジェクトなので MAGINAI_SAVE_KEYのプロパティにアクセス
          const maginaiSaveObject =
            self.previousUnzipWorkerResult[MAGINAI_SAVE_KEY];
          // もし存在すれば取得、存在しなければ空のオブジェクトを現在読み込んでいるMod用セーブとする
          if (maginaiSaveObject !== undefined) {
            self.rootSaveObject = maginaiSaveObject;
          } else {
            self.rootSaveObject = {};
          }
          self.isSaveAvailable = true;
          self.previousUnzipWorkerResult = null;
        }
        return origMethod.call(this, ...args);
      };
      return rtnFn;
    });

    // tGameMap.initSaveDataにパッチし、ゲームを最初から始めたときに
    // Mod用セーブデータに空のオブジェクトをセットし、セーブ利用可能フラグをtrueにする
    patcher.patchMethod(tGameMap, 'initSaveData', (origMethod) => {
      const rtnFn = function (...args) {
        self.isSaveAvailable = true;
        self.rootSaveObject = {};
        origMethod.call(this, ...args);
      };
      return rtnFn;
    });

    // tGameSave.getSaveDataにパッチし、Mod用セーブオブジェクトをルートのセーブオブジェクトにセットする
    // getSaveDataではルートのセーブオブジェクトの作成とtWgm.tGameSave等からのセーブオブジェクトの収集をしているので
    // 返り値のルートセーブオブジェクトにMod用セーブオブジェクトをセットすればOK
    patcher.patchMethod(tGameSave, 'getSaveData', (origMethod) => {
      const rtnFn = function (...args) {
        // もとのメソッドで作成されたルートセーブオブジェクトを取得
        const saveObject = origMethod.call(this, ...args);
        // セットの前に、イベントを発行し各Modのセーブオブジェクトをセットするよう伝達
        self.saveObjectRequired.invoke({});
        // セット
        saveObject[MAGINAI_SAVE_KEY] = self.rootSaveObject;
        return saveObject;
      };

      return rtnFn;
    });

    // tGameTitle.viewTitleにパッチし、タイトルに戻ったときにセーブ利用可フラグをfalseにする
    patcher.patchMethod(tGameTitle, 'viewTitle', (origMethod) => {
      const rtnFn = function (...args) {
        self.isSaveAvailable = false;
        return origMethod.call(this, ...args);
      };

      return rtnFn;
    });
  }

  /**
   * Returns the save object corresponding to the key `name` from the current save data
   * If no save object for `name` exists, returns `undefined`.
   *
   * @param {string} name
   */
  getSaveObject(name) {
    if (!this.isSaveAvailable) throw new Error('No save data loaded');
    return this.rootSaveObject[name];
  }

  /**
   * Sets `obj` as a save object corresponding to the key `name`
   * The object will be written to the current save data the next time a save operation is performed (e.g. when the player selects 'Save' in the menu)
   *
   * @param {string} name
   * @param {object} saveObj
   */
  setSaveObject(name, saveObj) {
    if (!this.isSaveAvailable) throw new Error('No save data loaded');
    if (saveObj === undefined) {
      throw new Error(
        "You can't set undefined as a save object. Use removeSaveObject to remove existing save object"
      );
    }
    this.rootSaveObject[name] = saveObj;
  }

  /**
   * Removes the save object corresponding to the key `name`.
   * The removal will be reflected in the current save data the next time a save operation is performed (e.g. when the player selects 'Save' in the menu)
   *
   * @param {string} name
   */
  removeSaveObject(name) {
    if (!this.isSaveAvailable) throw new Error('No save data loaded');
    delete this.rootSaveObject[name];
  }
}
