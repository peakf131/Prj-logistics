# Builds the new local and business pages from the insurance.html template (same header, styles, footer).
import re, json, html as H
import pathlib
SITE=str(pathlib.Path(__file__).resolve().parent.parent/'site')+'/'
tpl=open(SITE+'insurance.html').read()
head_css=tpl[tpl.index('<link rel="icon"'):tpl.index('</style>')]
EXTRA='''
.policy p,.policy ul,.policy ol{margin-bottom:16px}.policy h2{margin-top:34px}.policy h3{margin-top:22px}
.policy ul,.policy ol{padding-left:22px}.policy li{margin:6px 0}
.pc{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 20px}.pc span{background:#EEF2EC;border:1px solid #D9DFD6;border-radius:99px;padding:4px 12px;font-weight:600;font-size:.95rem}
.cta{background:#040C18;color:#fff;border-radius:18px;padding:24px 26px;margin:34px 0;display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between;border-left:6px solid var(--green)}
.cta p{margin:0!important;color:#C9D2DC}.cta b{display:block;color:#fff;font:700 1.7rem/1.1 'Barlow Condensed',sans-serif;margin-bottom:4px}
.btns{display:flex;gap:10px;flex-wrap:wrap}
.btn{display:inline-block;text-decoration:none;font-weight:700;border-radius:10px;padding:12px 18px;background:var(--green);color:#040C18}
.btn.o{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.4)}
.more{background:#EEF2EC;border-radius:16px;padding:18px 22px;margin-top:30px}.more a{color:#1F5C0E;font-weight:600}
.policy a{color:#2E6A12}
.policy a.btn{color:#040C18;text-decoration:none}.policy a.btn.o{color:#fff}
'''
WA='https://wa.me/message/EK6XFRXBKYFLN1'
def cta(title,text):
    return f'''<div class="cta"><div><b>{title}</b><p>{text}</p></div><div class="btns"><a class="btn" href="index.html#quote">Get a price</a><a class="btn o" href="{WA}">WhatsApp</a><a class="btn o" href="tel:+447749818335">Call +44 7749 818335</a></div></div>'''
def page(slug,title,desc,h1,sub,body,schema):
    url='https://www.prjlogistics.co.uk/'+slug
    crumbs={"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"https://www.prjlogistics.co.uk/"},{"@type":"ListItem","position":2,"name":h1,"item":url}]}
    t=H.escape(title,quote=True);d=H.escape(desc,quote=True)
    out=f'''<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{t}</title>
<meta name="description" content="{d}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="PRJ Logistics Ltd">
<meta property="og:title" content="{t}">
<meta property="og:description" content="{d}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="https://www.prjlogistics.co.uk/og-image-v2.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="PRJ Logistics Ltd logo">
<meta property="og:locale" content="en_GB">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{t}">
<meta name="twitter:description" content="{d}">
<meta name="twitter:image" content="https://www.prjlogistics.co.uk/og-image-v2.jpg">
{head_css}{EXTRA}</style>
<script type="application/ld+json">
{json.dumps(schema,indent=1,ensure_ascii=False)}
</script>
<script type="application/ld+json">
{json.dumps(crumbs,indent=1,ensure_ascii=False)}
</script>
</head>
<body>
<header><div class="wrap">
    <a class="logo" href="index.html" aria-label="PRJ Logistics Ltd, home"><img src="prj-logistics-logo.webp" alt="PRJ Logistics Ltd" width="340" height="144"></a>
    <a class="back" href="index.html">&larr; Back to website</a>
</div></header>
<main><div class="wrap policy">
    <h1>{h1}</h1>
    <p class="sub">{sub}</p>
{body}
</div></main>
<footer><div class="wrap"><span>&copy; <span id="yr"></span> PRJ Logistics Ltd. Same-day courier, UK.</span><span><a href="index.html">Home</a> &middot; <a href="same-day-courier-reading.html">Reading</a> &middot; <a href="same-day-courier-wokingham.html">Wokingham</a> &middot; <a href="courier-for-business.html">For business</a> &middot; <a href="track.html">Track delivery</a> &middot; <a href="faq.html">FAQ</a> &middot; <a href="deliveries.html">Completed deliveries</a> &middot; <a href="insurance.html">Insurance</a> &middot; <a href="terms.html">Terms</a> &middot; <a href="privacy.html">Privacy policy</a></span></div></footer>
<script>document.getElementById('yr').textContent=new Date().getFullYear()</script>
</body>
</html>
'''
    open(SITE+slug,'w').write(out)
    words=len(re.sub(r'<[^>]+>',' ',body).split())
    print(slug,'words',words,'title',len(title),'desc',len(desc))

def service(name,area,desc):
    return {"@context":"https://schema.org","@type":"Service","name":name,"serviceType":"Courier service","description":desc,
            "provider":{"@type":"LocalBusiness","@id":"https://www.prjlogistics.co.uk/#business","name":"PRJ Logistics Ltd","url":"https://www.prjlogistics.co.uk/","telephone":"+44 7749 818335"},
            "areaServed":[{"@type":"City","name":a} for a in area]}

# ---------------- Reading ----------------
reading_body=f'''
    <p>PRJ Logistics is a small courier company based in Reading. When you book us, one of our own drivers collects your load in a van and drives it straight to the delivery address. There is no depot, no sorting centre and no swapping between vehicles on the way: one van, one load, straight to the door, usually on the same day.</p>
    <p>You get a clear price before we go. We are not VAT registered, so no VAT is added, and the price you accept is the price you pay as long as the job matches what you told us.</p>
{cta('Need something moved in Reading today?','Tell us where to collect and where to deliver. We reply with a clear price.')}
    <h2>Where we collect in Reading</h2>
    <p>Reading is our home area, so this is where we can usually respond the fastest. We collect from homes, shops, offices, workshops and business parks across Reading postcodes, including:</p>
    <div class="pc"><span>RG1 Reading town centre</span><span>RG2 Whitley, Green Park, Shinfield</span><span>RG4 Caversham</span><span>RG5 Woodley</span><span>RG6 Earley</span><span>RG7 Theale, Burghfield</span><span>RG30 Southcote, Tilehurst</span><span>RG31 Tilehurst, Calcot</span></div>
    <p>We also collect around the wider area, roughly from Newbury to Maidenhead and Ascot, including <a href="same-day-courier-wokingham.html">Wokingham, Bracknell and Twyford</a>. From Reading we deliver anywhere up to 200 miles away, for example to London, Heathrow, Oxford, Southampton, Bristol or Birmingham. Further than that? Just ask.</p>

    <h2>What we can carry</h2>
    <p>We run long wheelbase (LWB) and short wheelbase (SWB) vans, each taking loads up to approximately 1,100 kg. That covers most same-day work from Reading:</p>
    <ul>
      <li><b>Documents and parcels</b> that need to arrive today, not tomorrow.</li>
      <li><b>Parts and equipment</b> for workshops, engineers and production lines that cannot wait.</li>
      <li><b>Pallets and trade stock.</b> Our vans have no tail lift, so a forklift, or enough people to unload by hand, is needed at both ends.</li>
      <li><b>Furniture and large items</b> for shops, makers and private customers.</li>
    </ul>
    <p>Not sure which van you need? Tell us roughly what you are sending and how heavy it is, and we will pick the right vehicle. A rough weight is fine.</p>

    <h2>How booking a same-day courier in Reading works</h2>
    <ol>
      <li><b>Ask for a price.</b> Use the quote form on our home page, message us on WhatsApp or call. Collections run Monday to Friday, between 08:00 and 18:00.</li>
      <li><b>Accept your price.</b> One clear, all-inclusive price, agreed before we go. Private customers pay by card through a secure link; businesses can ask to pay by invoice.</li>
      <li><b>We collect.</b> Your driver arrives at the agreed time, checks the load and secures it for the journey.</li>
      <li><b>We deliver with proof.</b> The van goes straight to the address. You can follow the job on our <a href="track.html">tracking page</a>, and we photograph the delivery and record the name of the person who received it.</li>
    </ol>
    <p>If you book later in the day, we can often still collect after 4pm, but same-day delivery is not guaranteed for late bookings. We will always tell you honestly before you accept.</p>

    <h2>Why Reading customers choose a local courier</h2>
    <p>Both of our directors started out as couriers, driving these routes every day. That is why we keep things simple: you talk to the people who actually do the job, not a call centre, and your load gets personal attention from collection to delivery.</p>
    <ul>
      <li><b>Price confirmed before we go</b>, with no VAT added.</li>
      <li><b>A dedicated van</b> for your load, with no transfers between vehicles.</li>
      <li><b>Photo proof of delivery</b> and a reference number you can track.</li>
      <li><b>Insured</b> with goods in transit and public liability cover. <a href="insurance.html">Read about our insurance</a>.</li>
    </ul>

    <h2>Regular deliveries for Reading businesses</h2>
    <p>If your business sends parts, stock or documents every week, we can agree rates and invoice terms, with payment within 7 days, and give you priority when you need a van in a hurry. See our page for <a href="courier-for-business.html">business deliveries</a>.</p>
{cta('Get your Reading courier price','Send us the collection and delivery address and we will reply with a clear price.')}
    <div class="more">More: <a href="faq.html">Same-day courier FAQs</a> &middot; <a href="deliveries.html">Recent deliveries</a> &middot; <a href="insurance.html">Insurance</a> &middot; <a href="terms.html">Terms</a></div>
'''
page('same-day-courier-reading.html','Same-day courier in Reading | PRJ Logistics Ltd',
     'Local same-day van courier in Reading. Price confirmed before we go, no VAT added. LWB and SWB vans up to 1,100 kg, delivering up to 200 miles.',
     'Same-day courier in Reading','A local van courier for urgent parcels, parts, pallets and furniture. Collected in Reading and driven straight to the door.',
     reading_body,service('Same-day courier in Reading',['Reading','Caversham','Woodley','Earley','Tilehurst','Theale','Shinfield'],'Same-day van courier collecting across Reading and delivering up to 200 miles away, with the price confirmed before collection and no VAT added.'))

# ---------------- Wokingham ----------------
wok_body=f'''
    <p>PRJ Logistics collects across Wokingham and the surrounding towns and villages, and drives your load straight to its destination, usually on the same day. We are a local company based next door in Reading, so Wokingham is part of our home area, not a long detour for a national network.</p>
    <p>Every job gets its own van and a clear price before we go. We are not VAT registered, so no VAT is added to the price you agree.</p>
{cta('Need a same-day courier in Wokingham?','Tell us where to collect and where to deliver. We reply with a clear price.')}
    <h2>Areas we cover around Wokingham</h2>
    <p>We collect from homes, shops, workshops, offices and business parks across the Wokingham area, including:</p>
    <div class="pc"><span>RG40 Wokingham, Finchampstead</span><span>RG41 Wokingham, Winnersh</span><span>RG12 and RG42 Bracknell</span><span>RG45 Crowthorne</span><span>RG10 Twyford, Wargrave</span><span>Arborfield</span><span>Ascot</span></div>
    <p>From there we deliver anywhere up to 200 miles away, for example to London, Heathrow, Oxford, Southampton, Bristol or Birmingham. We also cover <a href="same-day-courier-reading.html">all of Reading</a>. Need something further? Ask us and we will tell you straight away whether we can do it.</p>

    <h2>Typical same-day jobs from Wokingham</h2>
    <p>Most of our Wokingham work is for local businesses that need something moved today, plus private customers with a single large item. For example:</p>
    <ul>
      <li><b>Urgent parts and equipment</b> for engineers, workshops and offices on business parks such as Winnersh Triangle.</li>
      <li><b>Stock and orders</b> for local shops and online sellers that need to reach a customer or a warehouse the same day.</li>
      <li><b>Pallets and trade materials.</b> Our vans have no tail lift, so a forklift, or enough people to unload by hand, is needed at both ends.</li>
      <li><b>Furniture and large items</b> bought locally or online that will not fit in a car.</li>
    </ul>

    <h2>Our vans</h2>
    <p>We run long wheelbase (LWB) and short wheelbase (SWB) vans, each taking up to approximately 1,100 kg. The SWB is quick and flexible for urgent, medium-sized jobs; the LWB takes bulky and heavy loads, including pallets. Tell us roughly what you are sending and we will match the van to the load.</p>

    <h2>How it works</h2>
    <ol>
      <li><b>Get a price</b> with the quote form on our home page, on WhatsApp or by phone. Collections run Monday to Friday, between 08:00 and 18:00.</li>
      <li><b>Accept the price.</b> It is all-inclusive and agreed before we go. Businesses can ask to pay by invoice.</li>
      <li><b>We collect and drive straight there.</b> One van, one load, no transfers on the way.</li>
      <li><b>Proof of delivery.</b> We photograph the delivery and record who received it, and you can follow the job on our <a href="track.html">tracking page</a>.</li>
    </ol>
    <p>Bookings after 4pm can often still be collected, but same-day delivery is not guaranteed for late bookings. We will tell you honestly before you accept.</p>

    <h2>Why a local courier for Wokingham</h2>
    <p>Our directors started out as couriers driving these roads every day. You speak to the people who do the job, you know the price before we set off, and your goods are covered by our goods in transit and public liability insurance (<a href="insurance.html">details here</a>).</p>
    <p>For businesses with regular deliveries, we agree rates and invoice terms with payment within 7 days. See <a href="courier-for-business.html">courier services for business</a>.</p>

    <h2>Questions from Wokingham customers</h2>
    <h3>How quickly can you collect?</h3>
    <p>It depends on where our vans are when you call. We tell you the collection time together with the price, so you can decide before you book.</p>
    <h3>Can you deliver a pallet to a house?</h3>
    <p>Yes, as long as someone can take it off the van. We have no tail lift, so a forklift, or enough people to unload by hand, is needed at the delivery address. The pallet stays with your goods.</p>
    <h3>Will the price change on the day?</h3>
    <p>No, as long as the job matches what you told us. The only possible extras, such as waiting over 20 minutes or an extra stop, are listed in our <a href="faq.html">FAQ</a> and <a href="terms.html">terms</a>.</p>
{cta('Get your Wokingham courier price','Send us the collection and delivery address and we will reply with a clear price.')}
    <div class="more">More: <a href="faq.html">Same-day courier FAQs</a> &middot; <a href="deliveries.html">Recent deliveries</a> &middot; <a href="insurance.html">Insurance</a> &middot; <a href="terms.html">Terms</a></div>
'''
page('same-day-courier-wokingham.html','Same-day courier in Wokingham | PRJ Logistics Ltd',
     'Same-day van courier in Wokingham, Bracknell, Winnersh and Twyford. Clear price before we go, no VAT added, LWB and SWB vans up to 1,100 kg.',
     'Same-day courier in Wokingham','Local same-day van deliveries from Wokingham, Bracknell and the villages around, straight to the door.',
     wok_body,service('Same-day courier in Wokingham',['Wokingham','Bracknell','Winnersh','Crowthorne','Finchampstead','Twyford','Wargrave'],'Same-day van courier collecting across Wokingham and Bracknell and delivering up to 200 miles away, with the price confirmed before collection and no VAT added.'))

# ---------------- Business ----------------
biz_body=f'''
    <p>Most of our work is for businesses in Reading, Wokingham and the towns around them. When something has to move today, you want one number to call, a driver who turns up, a clear price and proof that it arrived. That is what we do.</p>
{cta('Talk to us about your deliveries','A short call is enough to agree how we work together.')}
    <h2>What businesses get from PRJ Logistics</h2>
    <ul>
      <li><b>Agreed rates and priority booking</b> for companies with repeat deliveries.</li>
      <li><b>Pay by invoice.</b> After a short conversation we can agree invoice terms, with payment within 7 days.</li>
      <li><b>No VAT added.</b> We are not VAT registered, so the price you agree is the price you pay.</li>
      <li><b>One van, one load.</b> Your goods go straight from collection to delivery, with no depot and no transfers.</li>
      <li><b>Proof of delivery for every job.</b> A photo at delivery, the name of the person who received it, and a reference you can <a href="track.html">track</a>.</li>
      <li><b>Insured.</b> Goods in transit and public liability cover. <a href="insurance.html">Insurance details</a>.</li>
      <li><b>Real people.</b> You talk to the directors who run the vans, not a call centre.</li>
    </ul>

    <h2>Who we work for</h2>
    <p>Our vans are set up for the kind of urgent and regular work that local businesses send every week:</p>
    <ul>
      <li><b>Printers and sign makers:</b> finished jobs to customers and events, on deadline.</li>
      <li><b>Furniture makers, joiners and kitchen fitters:</b> finished pieces and materials, handled with care.</li>
      <li><b>Garages and motor factors:</b> urgent parts between branches, suppliers and workshops.</li>
      <li><b>Builders' merchants and trade suppliers:</b> trade stock and materials to site or to a customer.</li>
      <li><b>Manufacturers and workshops:</b> components, samples and equipment between sites.</li>
      <li><b>Shops and online sellers:</b> same-day orders and stock transfers.</li>
    </ul>

    <h2>Urgent jobs and regular runs</h2>
    <p><b>Urgent:</b> call or message us, tell us what is going where, and we give you a price before we go. Collections run Monday to Friday, between 08:00 and 18:00. After 4pm we can often still collect, though same-day delivery is not guaranteed for late bookings.</p>
    <p><b>Regular:</b> if you send on fixed days or to the same places, we can plan a regular run with agreed rates, so you do not need a new quote every time.</p>
    <p><b>Collection area:</b> around <a href="same-day-courier-reading.html">Reading</a> and <a href="same-day-courier-wokingham.html">Wokingham</a>, roughly from Newbury to Maidenhead and Ascot. <b>Delivery:</b> anywhere up to 200 miles from Reading, including London, Heathrow, Oxford, Southampton, Bristol and Birmingham.</p>

    <h2>Our vans</h2>
    <p>Long wheelbase (LWB) and short wheelbase (SWB) vans, each taking up to approximately 1,100 kg: from a single urgent box to several pallets. Our vans have no tail lift, so pallets need a forklift, or enough people to unload by hand, at both ends.</p>

    <h2>Subcontract work for other couriers</h2>
    <p>Need extra van capacity, or cover for a route outside your area? We take overflow work from other courier and logistics companies and deliver under your instructions, with photo proof of delivery you can pass on to your customer.</p>

    <h2>How to get started</h2>
    <ol>
      <li>Call, message us on WhatsApp or use the quote form for your first job.</li>
      <li>Tell us how often you send, where to and what, and whether you would like to pay by invoice.</li>
      <li>We agree rates and terms, and you have one number for every delivery after that.</li>
    </ol>

    <h2>Questions businesses ask</h2>
    <h3>Can you collect from our supplier and deliver to us?</h3>
    <p>Yes, if the supplier is in our collection area around Reading and Wokingham. Give us both addresses and the contact on site, and we will arrange the rest.</p>
    <h3>What happens if a delivery cannot be made?</h3>
    <p>We call you straight away and agree what to do. Failed delivery and waiting time charges are listed in our <a href="terms.html">terms</a>, and if we cannot carry out your job at all, you get a full refund.</p>
    <h3>Do we need a contract?</h3>
    <p>No. You can book single jobs whenever you need them. For regular work we simply agree rates and invoice terms in writing, by email.</p>
{cta('Set up deliveries for your business','Call, WhatsApp or ask for a price for your next job.')}
    <div class="more">More: <a href="faq.html">Same-day courier FAQs</a> &middot; <a href="deliveries.html">Recent deliveries</a> &middot; <a href="terms.html">Terms</a></div>
'''
page('courier-for-business.html','Business courier in Reading and Wokingham | PRJ Logistics',
     'Same-day and regular van deliveries for businesses in Reading and Wokingham. Agreed rates, invoice terms, no VAT added and photo proof of delivery.',
     'Business courier in Reading and Wokingham','Urgent and regular van deliveries for local businesses, with agreed rates, invoices and proof of delivery for every job.',
     biz_body,service('Business courier in Reading and Wokingham',['Reading','Wokingham','Bracknell','Newbury','Maidenhead','Ascot'],'Same-day and regular van deliveries for businesses, with agreed rates, invoice terms, no VAT added and photo proof of delivery.'))
