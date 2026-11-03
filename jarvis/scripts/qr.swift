// Prints the text read from STDIN as a QR code in the terminal, two rows per line with half blocks.
// Colours are explicit, so it scans on both light and dark terminals. The text is never an argument.
import CoreImage
import Foundation

let input = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8)?
    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
guard !input.isEmpty, let filter = CIFilter(name: "CIQRCodeGenerator") else {
    FileHandle.standardError.write(Data("qr: nothing to encode\n".utf8))
    exit(1)
}
filter.setValue(Data(input.utf8), forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")
guard let image = filter.outputImage,
      let cg = CIContext().createCGImage(image, from: image.extent) else { exit(1) }

let size = cg.width, quiet = 4, total = size + quiet * 2
var gray = [UInt8](repeating: 255, count: size * size)
let ctx = CGContext(data: &gray, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size,
                    space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
ctx.interpolationQuality = .none
ctx.draw(cg, in: CGRect(x: 0, y: 0, width: size, height: size))

func dark(_ x: Int, _ y: Int) -> Bool {
    let px = x - quiet, py = y - quiet
    return px >= 0 && py >= 0 && px < size && py < size && gray[py * size + px] < 128
}
func colour(_ d: Bool) -> Int { d ? 16 : 231 }

var out = ""
for y in stride(from: 0, to: total, by: 2) {
    for x in 0..<total {
        out += "\u{1B}[38;5;\(colour(dark(x, y)))m\u{1B}[48;5;\(colour(dark(x, y + 1)))m\u{2580}"
    }
    out += "\u{1B}[0m\n"
}
print(out, terminator: "")
