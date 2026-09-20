// Text extraction CLI: PDF text layers via PDFKit, OCR via Apple's Vision framework.
//
// Usage:
//   ocr [--fast] <file>...                  print text per file (NUL-separated)
//   ocr --json --render-dir DIR <file>      per-page JSON so a caller can send image pages to a
//                                           vision model: {"pages":[{"text":..,"image":path|null}]}
//                                           "text" is the text layer when present, else Vision OCR;
//                                           "image" is a rendered JPEG for pages without a text layer.
// Accurate Vision fails with an opaque error on some setups; we then fall back to fast for the rest
// of the process and print "fallback:fast" to stderr so the caller can pass --fast next time.
import Foundation
import Vision
import PDFKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments.dropFirst()
let languages = ["de-DE", "en-US"]
var level: VNRequestTextRecognitionLevel = args.contains("--fast") ? .fast : .accurate
let jsonMode = args.contains("--json")
/// Render every page, even ones with a text layer. Used by the OCR benchmark, which needs the
/// layer text as ground truth and the rendered page as the input to score against it.
let renderAll = args.contains("--render-all")
let renderDir: String? = { if let i = args.firstIndex(of: "--render-dir"), i + 1 < args.endIndex { return args[i + 1] } ; return nil }()
let files = zip(args, args.dropFirst() + [""]).compactMap { (a, _) -> String? in a }.enumerated()
    .filter { (i, a) in !a.hasPrefix("--") && !(i > 0 && Array(args)[i - 1] == "--render-dir") }.map { $0.element }

func attempt(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = level
    request.recognitionLanguages = languages
    request.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

func recognise(_ image: CGImage) -> String {
    if let text = try? attempt(image) { return text }
    if level == .accurate {
        level = .fast
        FileHandle.standardError.write("fallback:fast\n".data(using: .utf8)!)
        if let text = try? attempt(image) { return text }
    }
    return ""
}

/// Rasterises a PDF page so its longest side is about `maxSide` pixels.
func render(page: PDFPage, maxSide: CGFloat = 2200) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    let scale = min(maxSide / max(bounds.width, bounds.height), 4)
    let w = Int(bounds.width * scale), h = Int(bounds.height * scale)
    guard w > 0, h > 0,
          let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: -bounds.origin.x, y: -bounds.origin.y)
    page.draw(with: .mediaBox, to: ctx)
    return ctx.makeImage()
}

func writeJpeg(_ image: CGImage, to path: String) -> Bool {
    guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    return CGImageDestinationFinalize(dest)
}

let minLetters = 12
func hasUsableText(_ s: String) -> Bool { s.unicodeScalars.filter { CharacterSet.letters.contains($0) }.count >= minLetters }

struct Page { let text: String; let image: String?; let bornDigital: Bool }

/// True when the page draws a large raster image, i.e. it is a scan rather than born-digital text.
/// Born-digital pages have an exact text layer, which makes them usable as OCR ground truth.
func hasLargeImage(_ page: PDFPage) -> Bool {
    guard let cgPage = page.pageRef,
          let dict = cgPage.dictionary else { return true }
    var resources: CGPDFDictionaryRef? = nil
    guard CGPDFDictionaryGetDictionary(dict, "Resources", &resources), let res = resources else { return false }
    var xobjects: CGPDFDictionaryRef? = nil
    guard CGPDFDictionaryGetDictionary(res, "XObject", &xobjects), let xo = xobjects else { return false }

    final class Box { var found = false }
    let box = Box()
    CGPDFDictionaryApplyFunction(xo, { _, value, info in
        let box = Unmanaged<Box>.fromOpaque(info!).takeUnretainedValue()
        var stream: CGPDFStreamRef? = nil
        guard CGPDFObjectGetValue(value, .stream, &stream), let st = stream,
              let sd = CGPDFStreamGetDictionary(st) else { return }
        var subtype: UnsafePointer<Int8>? = nil
        guard CGPDFDictionaryGetName(sd, "Subtype", &subtype), let sub = subtype,
              String(cString: sub) == "Image" else { return }
        var w: CGPDFInteger = 0, h: CGPDFInteger = 0
        CGPDFDictionaryGetInteger(sd, "Width", &w)
        CGPDFDictionaryGetInteger(sd, "Height", &h)
        if w * h > 500_000 { box.found = true }
    }, Unmanaged.passUnretained(box).toOpaque())
    return box.found
}

/// Extracts pages from a file; `renderTo` receives image pages that a caller may want to process further.
func pages(of path: String, renderTo dir: String?) -> [Page] {
    let url = URL(fileURLWithPath: path)
    let stem = url.deletingPathExtension().lastPathComponent
    if let pdf = PDFDocument(url: url), pdf.pageCount > 0 {
        var out: [Page] = []
        for i in 0..<pdf.pageCount {
            guard let page = pdf.page(at: i) else { continue }
            let layer = page.string
            let hasLayer = layer.map(hasUsableText) ?? false
            let born = hasLayer && !hasLargeImage(page)
            if hasLayer && !renderAll { out.append(Page(text: layer!, image: nil, bornDigital: born)); continue }
            guard let img = render(page: page) else { continue }
            var imagePath: String? = nil
            if let dir = dir {
                let p = "\(dir)/\(stem)-p\(i + 1).jpg"
                if writeJpeg(img, to: p) { imagePath = p }
            }
            // With --render-all the text stays the layer text (the reference); otherwise we OCR.
            out.append(Page(text: hasLayer ? layer! : recognise(img), image: imagePath, bornDigital: born))
        }
        return out
    }
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return [] }
    return [Page(text: recognise(img), image: dir == nil ? nil : path, bornDigital: false)]
}

if files.isEmpty {
    FileHandle.standardError.write("usage: ocr [--fast] [--json --render-dir DIR [--render-all]] <file>...\n".data(using: .utf8)!)
    exit(1)
}
if jsonMode {
    let result = files.map { f in ["pages": pages(of: f, renderTo: renderDir).map { ["text": $0.text, "image": $0.image as Any, "bornDigital": $0.bornDigital] }] }
    let data = try! JSONSerialization.data(withJSONObject: files.count == 1 ? result[0] : result)
    print(String(data: data, encoding: .utf8)!)
} else {
    for (i, f) in files.enumerated() {
        if i > 0 { print("\u{0}", terminator: "") }
        print(pages(of: f, renderTo: nil).map { $0.text }.joined(separator: "\n"), terminator: "")
    }
    print("")
}
