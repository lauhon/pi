import PDFKit; import AppKit
let a=CommandLine.arguments; let doc=PDFDocument(url: URL(fileURLWithPath:a[1]))!
for i in 0..<doc.pageCount { let p=doc.page(at:i)!; let r=p.bounds(for:.mediaBox); let s:CGFloat=1.2
 let img=NSImage(size:NSSize(width:r.width*s,height:r.height*s)); img.lockFocus(); NSColor.white.set(); NSRect(x:0,y:0,width:r.width*s,height:r.height*s).fill()
 let ctx=NSGraphicsContext.current!.cgContext; ctx.scaleBy(x:s,y:s); p.draw(with:.mediaBox,to:ctx); img.unlockFocus()
 let rep=NSBitmapImageRep(data:img.tiffRepresentation!)!; try! rep.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:"\(a[2])-\(i+1).png")) }
print(doc.pageCount)
