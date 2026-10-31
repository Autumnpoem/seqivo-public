/* Preview-only launcher. Existing terminal/provider Python bindings are unchanged. */
#include <mach-o/dyld.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

int main(int argc, char **argv) {
  char self[PATH_MAX], canonical[PATH_MAX], python[PATH_MAX], target[PATH_MAX];
  uint32_t size = sizeof(self);
  if (_NSGetExecutablePath(self, &size) != 0 || !realpath(self, canonical)) return 126;
  char *slash = strrchr(canonical, '/');
  if (!slash) return 126;
  *slash = '\0';
  int length = snprintf(python, sizeof(python), "%s/../python/bin/python3.12", canonical);
  if (length < 0 || (size_t)length >= sizeof(python) || !realpath(python, target)) return 126;
  /* The loader verifies this tree; refuse a relocated binary that escapes it. */
  slash = strrchr(canonical, '/');
  if (!slash) return 126;
  *slash = '\0';
  size_t root_length = strlen(canonical);
  if (strncmp(target, canonical, root_length) || target[root_length] != '/') return 126;
  char **args = calloc((size_t)argc + 4, sizeof(char *));
  if (!args) return 126;
  args[0] = target;
  args[1] = "-E";
  args[2] = "-S";
  args[3] = "-B";
  for (int index = 1; index < argc; index++) args[index + 3] = argv[index];
  /* Affect only this subprocess. No global shell, provider or account settings. */
  size_t count = 0;
  while (environ[count]) count++;
  char **env = calloc(count + 1, sizeof(char *));
  if (!env) return 126;
  size_t used = 0;
  for (size_t index = 0; index < count; index++) {
    const char *entry = environ[index];
    if (!strncmp(entry, "PYTHON", 6) || !strncmp(entry, "DYLD_", 5) ||
        !strncmp(entry, "__PYVENV_LAUNCHER__=", 19)) continue;
    env[used++] = environ[index];
  }
  execve(target, args, env);
  return 126;
}
