/**
 * Keys whose values are personal data or secrets. Loggers in api and worker
 * censor them wherever they appear in the first three levels of a log object.
 */
const sensitiveKeys = [
  'email',
  'name',
  'firstName',
  'lastName',
  'phone',
  'address',
  'body',
  'text',
  'html',
  'subject',
  'password',
  'token',
  'secret',
];

export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...sensitiveKeys.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];
