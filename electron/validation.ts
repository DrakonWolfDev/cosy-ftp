import { z } from 'zod';

export const text = z
  .string()
  .max(32768)
  .refine(
    (value) => !/[\0\r\n]/.test(value),
    'Paths and names must not contain NUL or line breaks',
  );
export const id = z.string().min(1).max(128);
export const name = text
  .min(1)
  .max(255)
  .refine(
    (value) => value !== '.' && value !== '..' && !/[\\/]/.test(value),
    'Enter a single file or folder name',
  );
export const location = z.object({ sessionId: id, path: text.min(1) }).strict();
export const profile = z
  .object({
    id: id.optional(),
    name: text.trim().min(1).max(100),
    protocol: z.enum(['sftp', 'ftps', 'ftp']),
    host: text
      .trim()
      .min(1)
      .max(253)
      .refine((value) => !/[\s/\\@]/.test(value), 'Enter a hostname or IP address'),
    port: z.number().int().min(1).max(65535),
    username: text.min(1).max(256),
    initialPath: text.min(1).default('/'),
    password: z.string().max(8192).optional(),
    rememberPassword: z.boolean(),
    allowInsecure: z.boolean(),
  })
  .strict()
  .refine(
    (value) => value.protocol !== 'ftp' || value.allowInsecure,
    'Plain FTP requires explicit permission for an unencrypted connection',
  );
export const job = z
  .object({
    source: location,
    destination: location,
    names: z.array(name).min(1).max(10000),
    overwrite: z.boolean(),
    move: z.boolean(),
  })
  .strict();
export const draft = z
  .object({
    id,
    content: z
      .string()
      .refine(
        (value) => Buffer.byteLength(value, 'utf8') <= 2 * 1024 * 1024,
        'Text files are limited to 2 MiB',
      ),
  })
  .strict();
export function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => issue.message).join('; ');
  return error instanceof Error ? error.message : 'The operation failed';
}
