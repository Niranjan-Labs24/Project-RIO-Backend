/**
 * Read an uploaded file's name as UTF-8. Multer (busboy) defaults to latin1
 * for the `filename` parameter, so an Arabic file name such as
 * "تقرير ميداني.pdf" was stored and shown as "ØªÙØ±ÙØ± ÙÙØ¯Ø§ÙÙ.pdf".
 * Browsers send the name as UTF-8 bytes; spread this into every
 * FileInterceptor / FilesInterceptor.
 */
export const UTF8_FILE_NAMES = { defParamCharset: "utf8" } as const;
