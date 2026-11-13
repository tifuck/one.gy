package exec

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"

	"github.com/tifuck/one.gy/client/e2ee"
	"github.com/tifuck/one.gy/client/internal/localfs"
)

// E2EE thumbnails for images (sync option "thumbnails"), made like the
// website's: longest side at most 200 px, JPEG, then one AES-GCM seal under
// the file key with a random 12-byte nonce (static/crypto.js
// encryptThumbnail). WebP is skipped (no decoder in the standard library).

const (
	thumbMax       = 200
	thumbMaxSource = 64 << 20
	thumbMaxPixels = 50_000_000
)

var thumbExts = map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".gif": true}

// writeThumbnail stores the encrypted thumbnail of src at dst and returns
// its nonce (b64), or "" when src is not a usable image. Best effort.
func writeThumbnail(src string, size int64, key []byte, dst string) string {
	if !thumbExts[strings.ToLower(filepath.Ext(src))] || size > thumbMaxSource || size == 0 {
		return ""
	}
	jpg := makeThumbnail(src)
	if jpg == nil {
		return ""
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return ""
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return ""
	}
	nonce, err := e2ee.RandomBytes(e2ee.NonceSize)
	if err != nil {
		return ""
	}
	if os.WriteFile(dst, gcm.Seal(nil, nonce, jpg, nil), 0o600) != nil || localfs.SyncFile(dst) != nil {
		return ""
	}
	return e2ee.EncodeBase64(nonce)
}

func makeThumbnail(src string) []byte {
	f, err := localfs.Open(src)
	if err != nil {
		return nil
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > thumbMaxPixels {
		return nil
	}
	if _, err := f.Seek(0, 0); err != nil {
		return nil
	}
	img, _, err := image.Decode(f)
	if err != nil {
		return nil
	}
	var buf bytes.Buffer
	if jpeg.Encode(&buf, shrink(img, thumbMax), &jpeg.Options{Quality: 80}) != nil {
		return nil
	}
	return buf.Bytes()
}

// shrink box-filters img so its longest side is at most limit (never enlarges).
func shrink(img image.Image, limit int) image.Image {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= limit && h <= limit {
		return img
	}
	nw, nh := limit, h*limit/w
	if h > w {
		nw, nh = w*limit/h, limit
	}
	nw, nh = max(nw, 1), max(nh, 1)
	out := image.NewRGBA(image.Rect(0, 0, nw, nh))
	for y := 0; y < nh; y++ {
		y0, y1 := b.Min.Y+y*h/nh, b.Min.Y+max((y+1)*h/nh, y*h/nh+1)
		for x := 0; x < nw; x++ {
			x0, x1 := b.Min.X+x*w/nw, b.Min.X+max((x+1)*w/nw, x*w/nw+1)
			var r, g, bl, a, n uint64
			for sy := y0; sy < y1; sy++ {
				for sx := x0; sx < x1; sx++ {
					cr, cg, cb, ca := img.At(sx, sy).RGBA()
					r, g, bl, a, n = r+uint64(cr), g+uint64(cg), bl+uint64(cb), a+uint64(ca), n+1
				}
			}
			out.Set(x, y, color.RGBA64{uint16(r / n), uint16(g / n), uint16(bl / n), uint16(a / n)})
		}
	}
	return out
}
