import { createStudioServer } from './server.js'

createStudioServer().catch((err) => {
	console.error(err)
	process.exit(1)
})
