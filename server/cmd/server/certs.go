package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ensureSelfSignedCert makes sure DATA_DIR holds a server certificate signed
// by a local CA. The CA is name-constrained to private/VPN address space plus
// this server's own names, so a leaked CA key can't be used to impersonate
// arbitrary internet sites on devices that installed it. The CA persists
// across leaf renewals, so renewing the server certificate or a changed LAN
// address does not make every device re-trust anything.
//
// Files: ca.pem / ca-key.pem (install ca.pem on devices), cert.pem (leaf+CA
// chain) and key.pem (leaf key) used by the TLS listener.
func ensureSelfSignedCert(dataDir string, extraHosts []string, lg *slog.Logger) (certPath, keyPath string, err error) {
	certPath = filepath.Join(dataDir, "cert.pem")
	keyPath = filepath.Join(dataDir, "key.pem")
	caPath := filepath.Join(dataDir, "ca.pem")
	caKeyPath := filepath.Join(dataDir, "ca-key.pem")

	dnsNames, allIPs := localCertificateNames(extraHosts...)
	nets := permittedNets(extraHosts)
	var ipAddresses []net.IP
	for _, ip := range allIPs {
		if ipInNets(ip, nets) {
			ipAddresses = append(ipAddresses, ip)
		}
	}

	ca, caKey, caOK := loadCA(caPath, caKeyPath)
	if caOK && !dnsPermitted(ca, dnsNames) {
		lg.Info("server names changed beyond what the CA allows; creating a new CA (devices must trust it again)")
		dnsNames = mergeDNS(ca.PermittedDNSDomains, dnsNames)
		caOK = false
	}
	if caOK && time.Now().After(ca.NotAfter.Add(-90*24*time.Hour)) {
		caOK = false
	}
	if !caOK {
		ca, caKey, err = createCA(caPath, caKeyPath, dnsNames, nets)
		if err != nil {
			return "", "", err
		}
	}

	if existing, certErr := loadExistingCertNames(certPath); certErr == nil {
		if _, keyErr := os.Stat(keyPath); keyErr == nil {
			expiringSoon := time.Now().After(existing.notAfter.Add(-30 * 24 * time.Hour))
			if existing.covers(dnsNames, ipAddresses) && !expiringSoon && existing.signedBy(ca) {
				return certPath, keyPath, nil
			}
			dnsNames = mergeDNS(existing.dns, dnsNames)
			ipAddresses = mergeIPs(filterNets(existing.ips, nets), ipAddresses)
			if !dnsPermitted(ca, dnsNames) {
				dnsNames = filterDNS(ca, dnsNames)
			}
		}
	}

	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return "", "", err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 62))
	if err != nil {
		return "", "", err
	}
	template := x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{Organization: []string{"Vision Call (Self-Signed)"}, CommonName: "Vision Call server"},
		NotBefore:    time.Now().Add(-5 * time.Minute),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     dnsNames,
		IPAddresses:  ipAddresses,
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, ca, &priv.PublicKey, caKey)
	if err != nil {
		return "", "", err
	}
	privBytes, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return "", "", err
	}
	chain := append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.Raw})...)
	// Key first, cert last, each atomically: a crash can't leave a mismatched
	// pair that stops the server starting.
	if err := writeFileAtomic(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privBytes}), 0o600); err != nil {
		return "", "", err
	}
	if err := writeFileAtomic(certPath, chain, 0o644); err != nil {
		return "", "", err
	}
	return certPath, keyPath, nil
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

var privateCIDRs = []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8", "fc00::/7", "fe80::/10", "::1/128"}

func permittedNets(extraHosts []string) []*net.IPNet {
	var out []*net.IPNet
	for _, c := range privateCIDRs {
		if _, n, err := net.ParseCIDR(c); err == nil {
			out = append(out, n)
		}
	}
	for _, h := range extraHosts {
		ip := net.ParseIP(strings.TrimSpace(h))
		if ip == nil {
			continue
		}
		bits := 128
		if v4 := ip.To4(); v4 != nil {
			ip, bits = v4, 32
		}
		mask := net.CIDRMask(bits, bits)
		out = append(out, &net.IPNet{IP: ip.Mask(mask), Mask: mask})
	}
	return out
}

func ipInNets(ip net.IP, nets []*net.IPNet) bool {
	for _, n := range nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func filterNets(ips []net.IP, nets []*net.IPNet) []net.IP {
	var out []net.IP
	for _, ip := range ips {
		if ipInNets(ip, nets) {
			out = append(out, ip)
		}
	}
	return out
}

func dnsAllowed(ca *x509.Certificate, name string) bool {
	for _, d := range ca.PermittedDNSDomains {
		if name == d || strings.HasSuffix(name, "."+d) {
			return true
		}
	}
	return false
}

// dnsPermitted reports whether every name is allowed by the CA's constraints.
func dnsPermitted(ca *x509.Certificate, names []string) bool {
	for _, n := range names {
		if !dnsAllowed(ca, n) {
			return false
		}
	}
	return true
}

func filterDNS(ca *x509.Certificate, names []string) []string {
	var out []string
	for _, n := range names {
		if dnsAllowed(ca, n) {
			out = append(out, n)
		}
	}
	return out
}

func loadCA(certPath, keyPath string) (*x509.Certificate, crypto.Signer, bool) {
	raw, err := os.ReadFile(certPath)
	if err != nil {
		return nil, nil, false
	}
	block, _ := pemDecode(raw)
	if block == nil {
		return nil, nil, false
	}
	cert, err := x509.ParseCertificate(block)
	if err != nil || !cert.IsCA || len(cert.PermittedDNSDomains) == 0 {
		return nil, nil, false
	}
	kraw, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, nil, false
	}
	kb, _ := pemDecode(kraw)
	if kb == nil {
		return nil, nil, false
	}
	k, err := x509.ParsePKCS8PrivateKey(kb)
	if err != nil {
		return nil, nil, false
	}
	signer, ok := k.(crypto.Signer)
	if !ok {
		return nil, nil, false
	}
	return cert, signer, true
}

func pemDecode(raw []byte) ([]byte, bool) {
	b, _ := pem.Decode(raw)
	if b == nil {
		return nil, false
	}
	return b.Bytes, true
}

func createCA(certPath, keyPath string, dnsNames []string, nets []*net.IPNet) (*x509.Certificate, crypto.Signer, error) {
	priv, err := rsa.GenerateKey(rand.Reader, 3072)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 62))
	if err != nil {
		return nil, nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:                serial,
		Subject:                     pkix.Name{Organization: []string{"Vision Call (Self-Signed)"}, CommonName: "Vision Call LAN CA"},
		NotBefore:                   time.Now().Add(-5 * time.Minute),
		NotAfter:                    time.Now().Add(5 * 365 * 24 * time.Hour),
		IsCA:                        true,
		BasicConstraintsValid:       true,
		MaxPathLen:                  0,
		MaxPathLenZero:              true,
		KeyUsage:                    x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		ExtKeyUsage:                 []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		PermittedDNSDomains:         dnsNames,
		PermittedIPRanges:           nets,
		PermittedDNSDomainsCritical: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		return nil, nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, err
	}
	kb, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, nil, err
	}
	if err := writeFileAtomic(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kb}), 0o600); err != nil {
		return nil, nil, err
	}
	if err := writeFileAtomic(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return nil, nil, err
	}
	return cert, priv, nil
}
