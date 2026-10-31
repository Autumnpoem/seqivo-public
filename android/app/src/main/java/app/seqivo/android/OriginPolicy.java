package app.seqivo.android;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

final class OriginPolicy {
    private OriginPolicy() {}

    static String normalize(String input) {
        if (input == null) return null;
        String value = input.trim();
        if (value.isEmpty()) return null;
        URI uri;
        try { uri = new URI(value); } catch (URISyntaxException error) { return null; }
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getHost().isEmpty()
                || uri.getUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                || !(uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath()))) return null;
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        if (!validHost(host)) return null;
        int port = uri.getPort();
        if (port < -1 || port == 0 || port > 65535) return null;
        return "https://" + printableHost(host) + (port == -1 || port == 443 ? "" : ":" + port);
    }

    static boolean contains(String origin, String url) {
        String normalized = normalize(origin);
        if (normalized == null || url == null) return false;
        try {
            URI uri = new URI(url);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null
                    || !validHost(uri.getHost().toLowerCase(Locale.ROOT))) return false;
            String candidate = "https://" + printableHost(uri.getHost().toLowerCase(Locale.ROOT))
                    + (uri.getPort() == -1 || uri.getPort() == 443 ? "" : ":" + uri.getPort());
            return normalized.equals(candidate);
        } catch (URISyntaxException error) { return false; }
    }

    private static boolean validHost(String host) {
        return host.matches("[a-z0-9.-]+") || host.matches("\\[?[0-9a-f:]+\\]?");
    }

    private static String printableHost(String host) {
        if (host.startsWith("[") && host.endsWith("]")) return host;
        return host.contains(":") ? "[" + host + "]" : host;
    }
}
