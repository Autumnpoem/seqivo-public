package app.seqivo.android;

import static org.junit.Assert.*;
import org.junit.Test;

public class OriginPolicyTest {
    @Test public void acceptsOnlyBareHttpsOrigins() {
        assertEquals("https://example.com", OriginPolicy.normalize(" HTTPS://Example.COM:443/ "));
        assertEquals("https://example.com:8443", OriginPolicy.normalize("https://example.com:8443"));
        assertNull(OriginPolicy.normalize("http://example.com"));
        assertNull(OriginPolicy.normalize("https://user:secret@example.com"));
        assertNull(OriginPolicy.normalize("https://example.com/path"));
        assertNull(OriginPolicy.normalize("https://example.com/?token=x"));
        assertNull(OriginPolicy.normalize("https://example.com/#section"));
        assertNull(OriginPolicy.normalize("javascript:alert(1)"));
    }

    @Test public void permitsOnlySameOriginNavigation() {
        String origin = "https://example.com";
        assertTrue(OriginPolicy.contains(origin, "https://EXAMPLE.com:443/api/state"));
        assertFalse(OriginPolicy.contains(origin, "https://example.com.attacker.test/"));
        assertFalse(OriginPolicy.contains(origin, "https://user@example.com/"));
        assertFalse(OriginPolicy.contains(origin, "http://example.com/"));
        assertFalse(OriginPolicy.contains(origin, "file:///sdcard/secret"));
        assertFalse(OriginPolicy.contains(origin, "https://example.com:8443/"));
    }
}
