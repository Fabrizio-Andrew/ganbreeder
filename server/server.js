const express = require('express')
const bodyParser = require('body-parser')
const request = require('request-promise')
const { Pool, Client } = require('pg')
const save_results = require('./save_results.js')
const port = process.argv[2] || 8888
const app = express()
const secrets= require('./secrets.js')
const knex = require('knex')(secrets.database)
const { performance } = require('perf_hooks')

const IMAGE_STATE = {
    INITIAL: 0,
    LOADING: 1
}

app.use(express.static('public'))
app.use(bodyParser.json())
app.set('view engine', 'pug')
app.set('views', 'public')

app.get('/i', async (req, res) => {
    const key = req.query.k
    if (!key) return res.sendStatus(404)
    const { id, vector, label, parent1 } = await knex.from('image').where({ key }).first()
    let pkey = null
    if (parent1 != null) {
        let res = await knex.select('key').from('image').where({ id: parent1 }).first()
        pkey = res.key
    }
    res.render('image.pug', { key, pkey })
})

app.get('/random', (req, res) => {
    const q = 'select key from image where parent1 is null OR state = 1 order by random() limit 12'
    knex.raw(q).then(data => {
        const keys = data.rows.map(({key}) => key)
        res.render('random.pug', { keys })
    }).catch(err => {
        console.log('Error: /random', { err })
        return res.sendStatus(500)
    })
})

app.get('/', (req, res) => res.redirect('/random'))

app.get('/mix', (req, res) => res.render('mix'))

app.post('/latest', async (req, res) => {
    try {
        const images = await knex.
            select('key').
            from('image').
            where({ id }).
            limit(32)
        return res.json(images.map(({ key }) => key))
    } catch(err) {
        console.log('Error: /latest', err)
        return res.sendStatus(500)
    }
})

app.post('/image_children', async (req, res) => {
    const key = req.body.key
    if (!key) return res.sendStatus(404)
    try {
        const { id, state, vector, label } = await knex.from('image').where({ key }).first()
        if (state == IMAGE_STATE.INITIAL) {
            const t = performance.now()
            const [ imgs, vectors, labels ] = await request({
                url: secrets.ganurl+'/children',
                method: 'POST',
                json: true,
                form: {
                    label: JSON.stringify(label),
                    vector: JSON.stringify(vector)
                }
            })
            console.log(`Made children in: ${performance.now() - t}`)
            await knex('image').where({ id }).update({ state: 1 })
            const children = await save_results({ imgs, vectors, labels, parent1: id })
            return res.json(children)
        } else if (state == 1) {
            const children = await knex.from('image').select('key').where({ parent1: id, parent2:null })
            if (children.length) {
                return res.json(children)
            }
            // Children are being processed, do not request more.
            return res.json([])
        }
    } catch(err) {
        console.log('Error: /image_children', err)
        return res.sendStatus(500)
    }
})

app.post('/mix_images', async (req, res) => {
    const key1 = req.body.key1
    const key2 = req.body.key2
    if (!key1 || !key2) return res.sendStatus(400)
    try {
        const image1 = await knex.from('image').where({ key:key1 }).first()
        const image2 = await knex.from('image').where({ key:key2 }).first()

        const [ imgs, vectors, labels ] = await request({
            url: secrets.ganurl+'/mix_images',
            method: 'POST',
            json: true,
            form: {
                label1: JSON.stringify(image1.label),
                label2: JSON.stringify(image2.label),
                vector1: JSON.stringify(image1.vector),
                vector2: JSON.stringify(image2.vector)
            }
        })
        const children = await save_results({ imgs, vectors, labels,
                                              parent1: image1.id,
                                              parent2: image2.id })
        return res.json(children)
    } catch(err) {
        console.log('Error: /mix', err)
        return res.sendStatus(500)
    }
})

app.listen(port, () => console.log('Server running on', port))