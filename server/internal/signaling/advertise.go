package signaling

import (
	"context"
	"net"
	"strings"
	"time"
)

// advertiseIP returns the server IP this client's browser connected to, taken
// from the Host header of its WebSocket request. The SFU puts that address in
// its ICE candidates, so call media goes to the same place the page was
// loaded from. That is what lets group calls work without EXTERNAL_IP, even
// in a Docker bridge network where the server only knows its container IP.
// Returns "" when the host can't be resolved.
func (c *Client) advertiseIP() string {
	c.advOnce.Do(func() { c.adv = hostToIP(c.host) })
	return c.adv
}

func hostToIP(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if host == "" {
		return ""
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.String()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil || len(ips) == 0 {
		return ""
	}
	for _, ip := range ips {
		if ip.To4() != nil {
			return ip.String()
		}
	}
	return ips[0].String()
}
