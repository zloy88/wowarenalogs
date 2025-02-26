/* eslint-disable no-console */
import { app, BrowserWindow, ClientRequestConstructorOptions, Display, net, screen } from 'electron';
import { access, existsSync, readdir, readFile, readFileSync, stat, unlink, writeFile } from 'fs-extra';
import path from 'path';
import { URL } from 'url';

// import { EventType, uIOhook, UiohookKeyboardEvent, UiohookMouseEvent } from 'uiohook-napi';
import { PTTKeyPressEvent } from './keyTypesUIOHook';
import { FileInfo, FileSortDirection, Metadata, ObsAudioConfig, OurDisplayType, VideoQueueItem } from './types';

const getResolvedHtmlPath = () => {
  if (process.env.NODE_ENV === 'development') {
    const port = process.env.PORT || 1212;

    return (htmlFileName: string) => {
      const url = new URL(`http://localhost:${port}`);
      url.pathname = htmlFileName;
      return url.href;
    };
  }

  return (htmlFileName: string) => {
    return `file://${path.resolve(__dirname, '../renderer/', htmlFileName)}`;
  };
};

export const resolveHtmlPath = getResolvedHtmlPath();

/**
 * Return information about a file needed for various parts of the application
 */
const getFileInfo = async (pathSpec: string): Promise<FileInfo> => {
  const filePath = path.resolve(pathSpec);
  const fstats = await stat(filePath);
  const mtime = fstats.mtime.getTime();
  const { size } = fstats;
  return { name: filePath, size, mtime };
};

/**
 * Asynchronously find and return a list of files in the given directory,
 * that matches the given pattern sorted by modification time according
 * to `sortDirection`. Ensure to properly escape patterns, e.g. ".*\\.mp4".
 */
const getSortedFiles = async (
  dir: string,
  pattern: string,
  sortDirection: FileSortDirection = FileSortDirection.NewestFirst,
): Promise<FileInfo[]> => {
  // We use fs.promises.readdir here instead of glob, which we used to
  // use but it caused problems with NFS paths, see this issue:
  // https://github.com/isaacs/node-glob/issues/74.
  const files = (await readdir(dir)).filter((f) => f.match(new RegExp(pattern))).map((f) => path.join(dir, f));

  const mappedFileInfo: FileInfo[] = [];

  for (let i = 0; i < files.length; i++) {
    // This loop can take a bit of time so we're deliberately
    // awaiting inside the loop to not induce a 1000ms periodic
    // freeze on the frontend. Probably can do better here,
    // suspect something in getFileInfo isn't as async as it could be.
    // If that can be solved, then we can drop the await here and then
    // do an await Promises.all() on the following line.
    // eslint-disable-next-line no-await-in-loop
    mappedFileInfo.push(await getFileInfo(files[i]));
  }

  if (sortDirection === FileSortDirection.NewestFirst) {
    return mappedFileInfo.sort((A: FileInfo, B: FileInfo) => B.mtime - A.mtime);
  }

  return mappedFileInfo.sort((A: FileInfo, B: FileInfo) => A.mtime - B.mtime);
};

/**
 * Get sorted video files. Shorthand for `getSortedFiles()` because it's used in quite a few places
 */
const getSortedVideos = async (
  storageDir: string,
  sortDirection: FileSortDirection = FileSortDirection.NewestFirst,
): Promise<FileInfo[]> => {
  return getSortedFiles(storageDir, '.*\\.mp4', sortDirection);
};

/**
 * Get the filename for the metadata file associated with the given video file.
 */
const getMetadataFileNameForVideo = (video: string) => {
  const videoFileName = path.basename(video, '.mp4');
  const videoDirName = path.dirname(video);
  return path.join(videoDirName, `${videoFileName}.json`);
};

/**
 * Get the filename for the thumbnail file associated with the given video file.
 */
const getThumbnailFileNameForVideo = (video: string) => {
  const videoFileName = path.basename(video, '.mp4');
  const videoDirName = path.dirname(video);
  return path.join(videoDirName, `${videoFileName}.png`);
};

/**
 * Get the metadata object for a video from the accompanying JSON file.
 */
const getMetadataForVideo = async (video: string) => {
  const metadataFilePath = getMetadataFileNameForVideo(video);
  await access(metadataFilePath);
  const metadataJSON = await readFile(metadataFilePath);
  const metadata = JSON.parse(metadataJSON.toString()) as Metadata;
  return metadata;
};

/**
 * Writes video metadata asynchronously and returns a Promise
 */
const writeMetadataFile = async (videoPath: string, data: VideoQueueItem) => {
  console.info('[Util] Write Metadata file', videoPath);

  const metadataFileName = getMetadataFileNameForVideo(videoPath);
  const jsonString = JSON.stringify({ videoPath, ...data }, null, 2);

  writeFile(metadataFileName, jsonString, {
    encoding: 'utf-8',
  });
};

/**
 * Try to unlink a file and return a boolean indicating the success
 * Logs any errors to the console, if the file couldn't be deleted for some reason.
 */
const tryUnlink = async (file: string): Promise<boolean> => {
  try {
    console.log(`[Util] Deleting: ${file}`);
    await unlink(file);
    return true;
  } catch (e) {
    console.error(`[Util] Unable to delete file: ${file}.`);
    console.error((e as Error).message);
    return false;
  }
};

/**
 * Delete a video and its metadata file if it exists.
 */
const deleteVideo = async (videoPath: string) => {
  console.info('[Util] Deleting video', videoPath);

  const success = await tryUnlink(videoPath);

  if (!success) {
    // If we can't delete the video file, make sure we don't delete the metadata
    // file either, which would leave the video file dangling.
    return;
  }

  const metadataPath = getMetadataFileNameForVideo(videoPath);
  await tryUnlink(metadataPath);

  const thumbnailPath = getThumbnailFileNameForVideo(videoPath);
  await tryUnlink(thumbnailPath);
};

/**
 * Put a save marker on a video, protecting it from the file monitor.
 */
const toggleVideoProtected = async (_videoPath: string) => {
  // TODO: MIGHTFIX re-implement protection from Size Monitor?
  throw new Error('Not implemented!');
  // let metadata;
  // try {
  //   metadata = await getMetadataForVideo(videoPath);
  // } catch (err) {
  //   console.error(
  //     `[Util] Metadata not found for '${videoPath}', but somehow we managed to load it. This shouldn't happen.`,
  //   );
  //   return;
  // }
  // if (metadata.protected === undefined) {
  //   console.info(`[Util] User protected ${videoPath}`);
  //   metadata.protected = true;
  // } else {
  //   metadata.protected = !metadata.protected;
  //   console.info(`[Util] User toggled protection on ${videoPath}, now ${metadata.protected}`);
  // }
  // await writeMetadataFile(videoPath, metadata);
};

/**
 * Get a text string that indicates the physical position of a display depending
 * on its index.
 */
const getDisplayPhysicalPosition = (count: number, index: number): string => {
  if (index === 0) return 'Left';
  if (index === count - 1) return 'Right';

  return `Middle #${index}`;
};

/**
 * Get and return a list of available displays on the system sorted by their
 * physical position.
 *
 * This makes no attempts at being perfect - it completely ignores the `bounds.y`
 * property for people who might have stacked their displays vertically rather than
 * horizontally. This is okay.
 */
const getAvailableDisplays = (): OurDisplayType[] => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const allDisplays = screen.getAllDisplays();

  // Create an unsorted list of Display IDs to zero based monitor index
  // So we're can use that index later, after sorting the displays according
  // to their physical location.
  const displayIdToIndex: { [key: number]: number } = {};

  allDisplays.forEach((display: Display, index: number) => {
    displayIdToIndex[display.id] = index;
  });

  // Iterate over all available displays and make our own list with the
  // relevant attributes and some extra stuff to make it easier for the
  // frontend.
  const ourDisplays: OurDisplayType[] = [];
  const numberOfMonitors = allDisplays.length;

  allDisplays
    .sort((A: Display, B: Display) => A.bounds.x - B.bounds.x)
    .forEach((display: Display, index: number) => {
      const isPrimary = display.id === primaryDisplay.id;
      const displayIndex = displayIdToIndex[display.id];
      const { width, height } = display.size;

      ourDisplays.push({
        id: display.id,
        index: displayIndex,
        physicalPosition: getDisplayPhysicalPosition(numberOfMonitors, index),
        primary: isPrimary,
        displayFrequency: display.displayFrequency,
        depthPerComponent: display.depthPerComponent,
        size: display.size,
        scaleFactor: display.scaleFactor,
        aspectRatio: width / height,
        physicalSize: {
          width: Math.floor(width * display.scaleFactor),
          height: Math.floor(height * display.scaleFactor),
        },
      });
    });

  return ourDisplays;
};

/**
 * Checks for updates from the releases page on github, and, if there is a
 * new version, sends a message to the main window to display a notification.
 */
const checkAppUpdate = (mainWindow: BrowserWindow | null = null) => {
  const options: ClientRequestConstructorOptions = {
    hostname: 'api.github.com',
    protocol: 'https:',
    path: '/repos/aza547/wow-recorder/releases/latest',
    method: 'GET',
  };

  const request = net.request(options);

  request.on('response', (response) => {
    let data = '';

    response.on('data', (chunk) => {
      data += chunk;
    });

    response.on('end', () => {
      if (response.statusCode !== 200) {
        console.error(`[Main] Failed to check for updates, status code: ${response.statusCode}`);
        return;
      }

      const release = JSON.parse(data);
      const latestVersion = release.tag_name;
      const link = release.assets[0].browser_download_url;

      if (latestVersion !== app.getVersion() && latestVersion && link) {
        console.log('[Util] New version available:', latestVersion);
        if (mainWindow === null) return;
        mainWindow.webContents.send('updateUpgradeStatus', true, link);
      }
    });
  });

  request.on('error', (error) => {
    console.error(`[Main] Failed to check for updates: ${error}`);
  });

  request.end();
};

const deferredPromiseHelper = <T>() => {
  let resolveHelper!: (value: T | PromiseLike<T>) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rejectHelper!: (reason?: any) => void;

  const promise = new Promise<T>((resolve, reject) => {
    resolveHelper = resolve;
    rejectHelper = reject;
  });

  return { resolveHelper, rejectHelper, promise };
};

const getAssetPath = (...paths: string[]): string => {
  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  return path.join(RESOURCES_PATH, ...paths);
};

/**
 * When packaged, we need to fix some paths
 */
export const fixPathWhenPackaged = (pathSpec: string) => {
  return pathSpec.replace('app.asar', 'app.asar.unpacked');
};

/**
 * Find and return the flavour of WoW that the log directory
 * belongs to by means of the '.flavor.info' file.
 */
const getWowFlavour = (pathSpec: string): string => {
  const flavourInfoFile = path.normalize(path.join(pathSpec, '../.flavor.info'));

  // If this file doesn't exist, it's not a subdirectory of a WoW flavour.
  if (!existsSync(flavourInfoFile)) {
    return 'unknown';
  }

  const content = readFileSync(flavourInfoFile).toString().split('\n');

  return content.length > 1 ? content[1] : 'unknown';
};

const isPushToTalkHotkey = (config: ObsAudioConfig, event: PTTKeyPressEvent) => {
  const { keyCode, mouseButton, altKey, ctrlKey, shiftKey, metaKey } = event;
  const { pushToTalkKey, pushToTalkMouseButton, pushToTalkModifiers } = config;

  const buttonMatch =
    (keyCode > 0 && keyCode === pushToTalkKey) || (mouseButton > 0 && mouseButton === pushToTalkMouseButton);

  const altMatch = altKey === pushToTalkModifiers.includes('alt');
  const ctrlMatch = ctrlKey === pushToTalkModifiers.includes('ctrl');
  const shiftMatch = shiftKey === pushToTalkModifiers.includes('shift');
  const winMatch = metaKey === pushToTalkModifiers.includes('win');

  return buttonMatch && altMatch && ctrlMatch && shiftMatch && winMatch;
};

// TODO: fix uiohook
// const convertUioHookKeyPressEvent = (event: UiohookKeyboardEvent): PTTKeyPressEvent => {
//   return {
//     altKey: event.altKey,
//     ctrlKey: event.ctrlKey,
//     metaKey: event.metaKey,
//     shiftKey: event.shiftKey,
//     keyCode: event.keycode,
//     mouseButton: -1,
//   };
// };

// const convertUioHookMousePressEvent = (event: UiohookMouseEvent): PTTKeyPressEvent => {
//   return {
//     altKey: event.altKey,
//     ctrlKey: event.ctrlKey,
//     metaKey: event.metaKey,
//     shiftKey: event.shiftKey,
//     keyCode: -1,
//     mouseButton: event.button as number,
//   };
// };

// const convertUioHookEvent = (event: UiohookKeyboardEvent | UiohookMouseEvent): PTTKeyPressEvent => {
//   if (event.type === EventType.EVENT_KEY_PRESSED) {
//     return convertUioHookKeyPressEvent(event as UiohookKeyboardEvent);
//   }

//   if (event.type === EventType.EVENT_KEY_RELEASED) {
//     return convertUioHookKeyPressEvent(event as UiohookKeyboardEvent);
//   }

//   if (event.type === EventType.EVENT_MOUSE_PRESSED) {
//     return convertUioHookMousePressEvent(event as UiohookMouseEvent);
//   }

//   if (event.type === EventType.EVENT_MOUSE_RELEASED) {
//     return convertUioHookMousePressEvent(event as UiohookMouseEvent);
//   }

//   return {
//     altKey: false,
//     shiftKey: false,
//     ctrlKey: false,
//     metaKey: false,
//     keyCode: -1,
//     mouseButton: -1,
//   };
// };

// const nextKeyPressPromise = (): Promise<PTTKeyPressEvent> => {
//   return new Promise((resolve) => {
//     uIOhook.once('keydown', (event) => {
//       resolve(convertUioHookEvent(event));
//     });
//   });
// };

// const nextMousePressPromise = (): Promise<PTTKeyPressEvent> => {
//   return new Promise((resolve) => {
//     uIOhook.once('mousedown', (event) => {
//       resolve(convertUioHookEvent(event));
//     });
//   });
// };

const getPromiseBomb = (fuse: number, reason: string) => {
  return new Promise((_resolve, reject) => setTimeout(reject, fuse, reason));
};

export {
  writeMetadataFile,
  deleteVideo,
  toggleVideoProtected,
  getSortedVideos,
  getAvailableDisplays,
  getSortedFiles,
  tryUnlink,
  checkAppUpdate,
  getMetadataForVideo,
  deferredPromiseHelper,
  getThumbnailFileNameForVideo,
  getAssetPath,
  getWowFlavour,
  isPushToTalkHotkey,
  // nextKeyPressPromise,
  // nextMousePressPromise,
  // convertUioHookEvent,
  getPromiseBomb,
};
